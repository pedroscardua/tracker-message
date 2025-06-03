import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import amqp from 'amqplib';
import axios from 'axios';
import { ZERO_WIDTH_CHARS } from './index.js';
import { sha256 } from './index.js';

// Expressão regular para remover emojis
const emojis = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/gu;

// Função para remover caracteres de largura zero de uma string
function removeZeroWidthChars(text) {
    if (!text) return '';
    return text.replace(new RegExp(`[${ZERO_WIDTH_CHARS.join('')}]`, 'g'), '');
}

// Carregar variáveis de ambiente
dotenv.config();

// Inicializar roteador Express
const router = express.Router();

// Middlewares
router.use(helmet());
router.use(cors());
router.use(morgan('combined'));
router.use(express.json());

// Configuração do PostgreSQL com reconexão automática
const createPool = () => {
    const pool = new Pool({
        user: process.env.PGUSER || 'postgres',
        host: process.env.PGHOST || 'localhost',
        database: process.env.PGDATABASE || 'tracker_db',
        password: process.env.PGPASSWORD || 'postgres',
        port: process.env.PGPORT || 5432,
        max: 200,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 2000,
        allowExitOnIdle: true,
    });

    pool.on('error', (err, client) => {
        console.error('Erro inesperado no cliente do pool:', err);
        if (err.message.includes('Connection terminated')) {
            console.log('Tentando reconectar ao banco de dados...');
            setTimeout(() => {
                try {
                    client.release(true);
                } catch (e) {
                    console.error('Erro ao liberar cliente:', e);
                }
                initPool();
            }, 5000);
        }
    });

    return pool;
};

let pool = createPool();

const initPool = () => {
    if (pool) {
        try {
            pool.end();
        } catch (e) {
            console.error('Erro ao encerrar pool existente:', e);
        }
    }
    pool = createPool();
    
    // Teste de conexão
    pool.query('SELECT NOW()', (err) => {
        if (err) {
            console.error('Erro ao conectar ao banco de dados:', err);
            console.log('Tentando reconectar em 5 segundos...');
            setTimeout(initPool, 5000);
        } else {
            console.log('Conexão com o banco de dados estabelecida com sucesso!');
        }
    });
};

// Inicializa a primeira conexão
initPool();

// Configuração do RabbitMQ
const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const QUEUE_NAME = 'messages.upsert';
//const QUEUE_NAME = 'evolution.messages.upsert';

// Função para consumir mensagens
async function consumeMessages() {
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        
        await channel.assertQueue(QUEUE_NAME, {
            durable: true,
            arguments: {
                'x-queue-type': 'quorum'
            }
        });

        console.log(`[*] Aguardando mensagens na fila ${QUEUE_NAME}`);

        channel.consume(QUEUE_NAME, async (msg) => {
            if (msg !== null) {
                try {
                    const message = JSON.parse(msg.content.toString());
                    console.log(`[x] Recebida mensagem ${message.instance} - ${message.data.key.remoteJid}`);

                    // Aqui você pode processar a mensagem conforme necessário
                    // Por exemplo, salvar no banco de dados
                    const client = await pool.connect();
                    try {
                        if (message.data.messageType !== 'conversation' || message.data.key.fromMe === true) {
                            console.log(`[x] Tipo de mensagem não é uma conversa ou recebida por mim:`, message.data.messageType, ` - `, message.data.key.fromMe);
                            channel.ack(msg);
                            return;
                        }
                        console.log(`[x] Mensagem:`, message);
                        let messageCoded = message.data.message.conversation;
                        let messageTrigger = removeZeroWidthChars(message.data.message.conversation);
                        // Remove apenas espaços U+0020 após o último caractere não-espaço
                        messageTrigger = messageTrigger.replace(/\s+$/g, '');
                        // remove um único '.' no final da mensagem
                        messageTrigger = messageTrigger.replace(/\.$/, '');
                        await client.query('BEGIN');

                        // Verifica se a instancia name está vinculada a um business 
                        const queryGetInstance = await client.query(
                            `SELECT * FROM whatsapp_instances WHERE instance_name = $1`,
                            [message.instance]
                        );
                        // se lista Instancia tem linha - Se não apenas faz nada
                        if (queryGetInstance.rows.length !== 0) {
                            console.log(`[x] Instância existe:`, message.instance);
                            if (queryGetInstance.rows.length !== 0 && (queryGetInstance.rows[0].business_id !== null || queryGetInstance.rows[0].business_id !== undefined || queryGetInstance.rows[0].business_id !== '')) {
                                
                                // Busca rota criada para trigger com a mensagem recebida
                                const queryRouterTracker = await client.query(
                                    `SELECT * FROM router_tracker WHERE business_id = $1 AND message_trigger = $2`,
                                    [queryGetInstance.rows[0].business_id, messageTrigger]
                                );
                                // se tem rota criada exatamente com a mesma mensagem continua - Se não busca todas rotas e verifica se mensagem recebida contem alguma das rotas
                                if (queryRouterTracker.rows.length !== 0) {
                                    console.log(`[x] Roteador de rastreio:`, queryRouterTracker.rows);
                                    console.log(`[x] Mensagem:`, messageTrigger);
                                    // Confere se as mensagens são realmente iguais
                                    if (messageTrigger.toString() === queryRouterTracker.rows[0].message_trigger.toString()){
                                        console.log(`[x] Mensagem corresponde ao trigger:`, messageTrigger);
                                        // Atualiza track atual com o WhatsApp o cliente
                                        const updateTracker = await client.query(
                                            `UPDATE tracker SET whatsapp_id = $1 WHERE business_id = $2 AND unique_code = $3 RETURNING *`,
                                            [message.data.key.remoteJid, queryGetInstance.rows[0].business_id, messageCoded]
                                        );

                                        
                                        // Verifica se cliente já está cadastrado no sitema tracker
                                        const getUser = await client.query(
                                            `SELECT * FROM tracker_leads WHERE whatsapp_id = $1`,
                                            [message.data.key.remoteJid]
                                        );

                                        let userId = "";
                                        let timestampINT64 = parseInt(Date.now() / 1000);
                                        let userIdentifierListIds = [];
                                        // se cliente encontrado - * Precisa fazer
                                        if (getUser.rows.length !== 0) {
                                            
                                            console.log(`[x] Usuário encontrado:`, getUser.rows);
                                            userId = "ID A DEFINIR";
                                        } else {
                                            
                                            
                                            console.log(`[x] Usuário não encontrado:`, message.data.key.remoteJid);
                                            // pega o Id de user usado no tracker inicial para disparar page visit
                                            const userIdentifierList = [updateTracker.rows[0].user_identifier_id]
                                            // Cria usuário com os dados recebidos do whatsapp e adiciona na lista o ID inicial usado para definir esse user
                                            const createUser = await client.query(
                                                `INSERT INTO tracker_leads (whatsapp_id,business_id,first_name, last_name, user_identifier_list, last_client_ip_address, client_ip_address_list, last_client_user_agent, client_user_agent_list) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
                                                [message.data.key.remoteJid, queryGetInstance.rows[0].business_id, message.data.pushName.replaceAll(emojis, '').split(' ')[0], message.data.pushName.replaceAll(emojis, '').split(' ')[1], userIdentifierList, updateTracker.rows[0].client_ip_address, [updateTracker.rows[0].client_ip_address], updateTracker.rows[0].client_user_agent, [updateTracker.rows[0].client_user_agent]]
                                            );
                                            console.log(`[x] Usuário criado:`, createUser.rows);
                                            // Atualiza tracker passando o ID oficial do user apos receber mensagem e criar user
                                            const updateTrackerLead = await client.query(
                                                `UPDATE tracker SET actual_user_id = $1 WHERE id = $2`,
                                                [createUser.rows[0].id, updateTracker.rows[0].id]
                                            );
                                            // Pega o ID oficial do usuario criado e adiciona na lista de ids que identificam esse user
                                            const updatedUserIdentifierList = [...createUser.rows[0].user_identifier_list, createUser.rows[0].id];
                                            const updateTrackerLeadFinal = await client.query(
                                                `UPDATE tracker_leads SET user_identifier_list = $1 WHERE id = $2 RETURNING *`,
                                                [updatedUserIdentifierList, createUser.rows[0].id]
                                            );
                                            console.log(`[x] Tracker lead atualizado:`, updateTrackerLeadFinal.rows);
                                            ///////// define dados user
                                            userId = createUser.rows[0].id;
                                            userIdentifierListIds = updateTrackerLeadFinal.rows[0].user_identifier_list;
                                        }
                                        //////
                                        //////    Enviar evento de conversão
                                        //////
                                        if(queryRouterTracker.rows[0].internal_source_id !== null && queryRouterTracker.rows[0].internal_source_id !== undefined && queryRouterTracker.rows[0].internal_source_id !== ''){
                                            const querySourceData = await client.query(
                                                `SELECT * FROM sources WHERE id = $1`,
                                                [queryRouterTracker.rows[0].internal_source_id]
                                            );
                                            // Verifica se tem source
                                            if(querySourceData.rows[0].length !== 0){
                                                /////
                                                ///// Verifica qual sistema de source usar
                                                /////
                                                // PINTEREST ////////

                                                const queryGetPinterest = await client.query(
                                                    `SELECT * FROM sources WHERE id = $1`,
                                                    [queryRouterTracker.rows[0].internal_source_id]
                                                );

                                                const parameters = queryGetPinterest.rows[0].paramters;
                                                const parametersMap = new Map(Object.entries(parameters));
                                                const pinterestToken = parametersMap.get('convertion_token');
                                                const adAccountId = parametersMap.get('ad_account_id');

                                                const event_id = `track_${updateTracker.rows[0].id}_user_${userId}_time_${timestampINT64}`;
                                                const ip_user = updateTracker.rows[0].client_ip_address;
                                                const userAgent = updateTracker.rows[0].client_user_agent;
                                                const product_id = queryRouterTracker.rows[0].product_id;
                                                const toShaListIds = userIdentifierListIds.map(id => sha256(id));
                                                const list_user_ids = toShaListIds;

                                                if(querySourceData.rows[0].type === 'pinterest'){
                                                    const data = {
                                                        "data": [
                                                          {
                                                            "action_source": "offline",
                                                            "event_id": event_id,
                                                            "event_name": "lead",
                                                            "event_time": timestampINT64,
                                                            "user_data": {
                                                              "client_ip_address": ip_user,
                                                              "client_user_agent": userAgent,
                                                              "external_id": list_user_ids,
                                                              "ph": [sha256(message.data.key.remoteJid.split('@')[0])],
                                                              "em": [sha256(message.data.key.remoteJid.split('@')[0])]
                                                            },
                                                            "custom_data": {
                                                              "content_ids": [product_id]
                                                            }
                                                          }
                                                        ]
                                                      };
                                  
                                                      try {
                                                        await axios.post(
                                                          `https://api.pinterest.com/v5/ad_accounts/${adAccountId}/events?test=true`,
                                                          data,
                                                          {
                                                            headers: {
                                                              'Authorization': `Bearer ${pinterestToken}`,
                                                              'Content-Type': 'application/json'
                                                            }
                                                          }
                                                        );
                                                      } catch (error) {
                                                        console.error('Erro ao enviar evento para o Pinterest:', error);
                                                      }

                                                }

                                            } 

                                        }

                                        //////
                                        //////    Enviar evento de CRM cadastro/update
                                        //////
                                        // Verificar qual sistema integrado a esse router_tracker.
                                        const querySystemIntegrated = await client.query(
                                            `SELECT * FROM sys_integrations WHERE id = $1`,
                                            [queryRouterTracker.rows[0].sys_integration_id]
                                        );
                                        // verifica se tem um sistema conectado a essa router
                                        if (querySystemIntegrated.rows.length !== 0) {
                                            console.log(`[x] Sistema integrado encontrado:`, querySystemIntegrated.rows);
                                            //////////
                                            //////////      Determina qual estrutura de sistema deve enviar a conversão
                                            //////////
                                            if (querySystemIntegrated.rows[0].type === 'clint') {
                                                console.log(`[x] Sistema integrado é o Clint:`, querySystemIntegrated.rows);
                                                const webhookUrl = 'https://functions-api.clint.digital/endpoints/integration/webhook/333525b4-0ed4-49ef-9805-fd573f1c5114';
                                                const payload = {
                                                    contact_tags: "tracker_lead, dadads, dwdsadw",
                                                    contact_name: message.data.pushName.replaceAll(emojis, ''),
                                                    contact_phone: message.data.key.remoteJid.split('@')[0],
                                                    contact_utm_campaign: updateTracker.rows[0].utm_campaign,
                                                    contact_utm_content: updateTracker.rows[0].utm_content,
                                                    contact_utm_source: updateTracker.rows[0].utm_source,
                                                    contact_utm_medium: updateTracker.rows[0].utm_medium
                                                };
                                                await axios.post(webhookUrl, payload);
                                                // response from webhook
                                                const response = await axios.post(webhookUrl, payload);
                                                console.log(`[x] Resposta do webhook:`, response.data);
                                            }
                                        }
                                    }
                                    
                                } else {
                                    const queryAllRouterTracker = await client.query(
                                        `SELECT * FROM router_tracker WHERE business_id = $1`,
                                        [queryGetInstance.rows[0].business_id]
                                    );
                                    // verify if contains messageTrigger in list of queryAllRouterTracker.rows.message_trigger
                                    const containsMessageTrigger = queryAllRouterTracker.rows.some(row => messageTrigger.toString().includes(row.message_trigger.toString()));
                                    if (containsMessageTrigger) {
                                        console.log(`[x] Roteador de rastreio encontrado:`, messageTrigger);
                                    } else {
                                        console.log(`[x] Roteador de rastreio não encontrado:`, messageTrigger);
                                    }
                                }
                            }
                        } else {
                            console.log(`[x] Instância não cadastrada:`, message.instance);
                        }

                        await client.query('COMMIT');
                    } catch (error) {
                        await client.query('ROLLBACK');
                        console.error('Erro ao processar mensagem:', error);
                    } finally {
                        client.release();
                    }

                    // Confirma o recebimento da mensagem
                    channel.ack(msg);
                } catch (error) {
                    console.error('Erro ao processar mensagem:', error);
                    // Rejeita a mensagem em caso de erro
                    channel.nack(msg);
                }
            }
        });
    } catch (error) {
        console.error('Erro ao conectar com RabbitMQ:', error);
        // Tenta reconectar após 5 segundos
        setTimeout(consumeMessages, 5000);
    }
}

// Inicia o consumidor
consumeMessages();

export default router; 