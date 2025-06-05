const pool = require('../db/pool');
const amqp = require('amqplib');
const axios = require('axios');
const { removeZeroWidthChars, CHARSToString, sha256 } = require('../functions');
const emojis = require('node-emoji');
const dotenv = require('dotenv');

// Carrega as variáveis de ambiente
const result = dotenv.config();
if (result.error) {
    console.error('Erro ao carregar .env:', result.error);
    process.exit(1);
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const QUEUE_NAME = 'evolution.messages.upsert';
const QUEUE_NAME_INTEGRATION = 'tracker_process_integration';
const QUEUE_NAME_SOURCE = 'tracker_process_source';
const PREFETCH_COUNT = process.env.RABBITMQ_PREFETCH_COUNT || 1000;

//const emojis = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F900}-\u{1F9FF}\u{1F1E0}-\u{1F1FF}]/gu;

let connection = null;
let channel = null;

// Função para fechar conexões graciosamente
async function closeGracefully() {
    // console.log('Fechando conexões...');
    try {
        if (channel) {
            await channel.close();
        }
        if (connection) {
            await connection.close();
        }
    } catch (error) {
        console.error('Erro ao fechar conexões:', error);
    } finally {
        process.exit(0);
    }
}

// Registra handlers para fechamento gracioso
process.once('SIGINT', closeGracefully);
process.once('SIGTERM', closeGracefully);

const ZERO_WIDTH_CHARS = [
    '\u200B',
    '\u200C', 
    '\u200D',
    '\u2063'
];

// Função para deixar apenas caracteres de largura zero de uma string
function onlyZeroWidthChars(text) {
    if (!text) return '';
    return text.split('').filter(char => ZERO_WIDTH_CHARS.includes(char)).join('');
}

// Função para consumir mensagens
async function consumeMessages() {
    try {
        if (!process.env.PROCESS_MESSAGES || process.env.PROCESS_MESSAGES !== 'true') {
            // console.log('Processamento de mensagens desativado');
            return;
        }

        connection = await amqp.connect(RABBITMQ_URL);
        channel = await connection.createChannel();
        
        // Configura prefetch para controle de carga
        await channel.prefetch(PREFETCH_COUNT);
        
        await channel.assertQueue(QUEUE_NAME, {
            durable: true,
            arguments: {
                'x-queue-type': 'quorum'
            }
        });

        // console.log(`[*] Aguardando mensagens na fila ${QUEUE_NAME}. Prefetch: ${PREFETCH_COUNT}`);

        // Configura handler para erros no canal
        channel.on('error', (error) => {
            console.error('Erro no canal RabbitMQ:', error);
            setTimeout(consumeMessages, 5000);
        });

        // Configura handler para fechamento do canal
        channel.on('close', () => {
            console.error('Canal RabbitMQ fechado');
            setTimeout(consumeMessages, 5000);
        });

        channel.consume(QUEUE_NAME, async (msg) => {
            if (msg !== null) {
                try {
                    const message = JSON.parse(msg.content.toString());
                    console.log(`[x] Recebida mensagem ${message.instance} - ${message.data.key.remoteJid}`);

                    // Aqui você pode processar a mensagem conforme necessário
                    // Por exemplo, salvar no banco de dados
                    const client = await pool.getClient();
                    try {
                        if (message.data.messageType !== 'conversation' || message.data.key.fromMe === true) {
                            // console.log(`[x] Tipo de mensagem não é uma conversa ou recebida por mim:`, message.data.messageType, ` - `, message.data.key.fromMe);
                            channel.ack(msg);
                            return;
                        }
                        // // console.log(`[x] Mensagem:`, message);
                        let messageCoded = message.data.message.conversation;
                        // console.log(`[x] Mensagem completa:`, messageCoded);
                        let unicode = onlyZeroWidthChars(message.data.message.conversation);
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
                                const queryTracker = await client.query(
                                    `SELECT * FROM tracker WHERE business_id = $1 AND unicode = $2`,
                                    [queryGetInstance.rows[0].business_id, unicode]
                                );
                                // se tem rota criada exatamente com a mesma mensagem continua - Se não busca todas rotas e verifica se mensagem recebida contem alguma das rotas
                                if (queryTracker.rows.length !== 0) {
                                    console.log(`[x] Tracker encontrada:`, queryTracker.rows[0].id);
                                    // Confere se as mensagens são realmente iguais
                                    if (unicode === queryTracker.rows[0].unicode){
                                        // console.log(`[x] Mensagem corresponde ao unicode:`, unicode);
                                        // Atualiza track atual com o WhatsApp o cliente
                                        const updateTracker = await client.query(
                                            `UPDATE tracker SET client_whatsapp_id = $1, client_whatsapp_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING *`,
                                            [message.data.key.remoteJid, queryTracker.rows[0].id]
                                        );
                                        
                                        if(updateTracker.rows.length >= 1){
                                            console.log(`[x] Tracker atualizado ✅✅✅ :`, updateTracker.rows[0].id);
                                        } else {
                                            console.log(`[x] Tracker não atualizado ❌❌❌ :`, updateTracker.rows.length);
                                        }

                                        
                                        // Verifica se cliente já está cadastrado no sitema tracker
                                        const getUser = await client.query(
                                            `SELECT * FROM tracker_leads WHERE whatsapp_id = $1 AND business_id = $2`,
                                            [message.data.key.remoteJid, queryGetInstance.rows[0].business_id]
                                        );

                                        let userId = "";
                                        let timestampINT64 = parseInt(Date.now() / 1000);
                                        let userIdentifierListIds = [];
                                        // se cliente encontrado - * Precisa fazer
                                        if (getUser.rows.length !== 0) {
                                            
                                            // console.log(`[x] Usuário encontrado:`, getUser.rows);
                                            userId = "ID A DEFINIR";

                                            const updateTrackerLead = await client.query(
                                                `UPDATE tracker SET actual_lead_id = $1 WHERE id = $2`,
                                                [getUser.rows[0].id, updateTracker.rows[0].id]
                                            );
                                            
                                            const updateUser = await client.query(
                                                `UPDATE tracker_leads SET 
                                                    last_client_ip_address = $1,
                                                    client_ip_address_list = array_append(client_ip_address_list, $1),
                                                    last_client_user_agent = $2,
                                                    client_user_agent_list = array_append(client_user_agent_list, $2)
                                                WHERE id = $3`,
                                                [updateTracker.rows[0].client_ip_address,
                                                 updateTracker.rows[0].client_user_agent,
                                                 getUser.rows[0].id]
                                            );

                                            // const updatedUserIdentifierList = [...getUser.rows[0].user_identifier_list, updateTracker.rows[0].user_identifier_id];

                                            // const updateTrackerLeadFinal = await client.query(
                                            //     `UPDATE tracker_leads SET user_identifier_list = $1 WHERE id = $2 RETURNING *`,
                                            //     [updatedUserIdentifierList, getUser.rows[0].id]
                                            // );
                                            // // console.log(`[x] Tracker lead lista de ids atualizada:`, updateTrackerLeadFinal.rows);

                                            userId = getUser.rows[0].id;
                                            // userIdentifierListIds = updateTrackerLeadFinal.rows[0].user_identifier_list;
                                            userIdentifierListIds = [getUser.rows[0].id];

                                            console.log(`[x] Tracker lead atualizado ✅ :`, getUser.rows[0].id);

                                        } else {
                                            
                                            
                                            // console.log(`[x] Usuário não encontrado:`, message.data.key.remoteJid);
                                            // pega o Id de user usado no tracker inicial para disparar page visit
                                            // const userIdentifierList = [updateTracker.rows[0].user_identifier_id]
                                            const userIdentifierList = []
                                            // Cria usuário com os dados recebidos do whatsapp e adiciona na lista o ID inicial usado para definir esse user
                                            const createUser = await client.query(
                                                `INSERT INTO tracker_leads (whatsapp_id,business_id,fullname, user_identifier_list, last_client_ip_address, client_ip_address_list, last_client_user_agent, client_user_agent_list) 
                                                 VALUES ($1,$2,$3,$4,$5,ARRAY[$5]::text[],$6,ARRAY[$6]::text[]) RETURNING *`,
                                                [message.data.key.remoteJid, 
                                                 queryGetInstance.rows[0].business_id, 
                                                 message.data.pushName.replaceAll(emojis, ''), 
                                                 userIdentifierList, 
                                                 updateTracker.rows[0].client_ip_address,
                                                 updateTracker.rows[0].client_user_agent]
                                            );
                                            // console.log(`[x] Usuário criado:`, createUser.rows);
                                            // Atualiza tracker passando o ID oficial do user apos receber mensagem e criar user
                                            const updateTrackerLead = await client.query(
                                                `UPDATE tracker SET actual_user_id = $1 WHERE id = $2`,
                                                [createUser.rows[0].id, updateTracker.rows[0].id]
                                            );
                                            // Pega o ID oficial do usuario criado e adiciona na lista de ids que identificam esse user
                                            const updatedUserIdentifierList = [createUser.rows[0].id];
                                            const updateTrackerLeadFinal = await client.query(
                                                `UPDATE tracker_leads SET user_identifier_list = $1 WHERE id = $2 RETURNING *`,
                                                [updatedUserIdentifierList, createUser.rows[0].id]
                                            );
                                            //// console.log(`[x] Tracker lead atualizado:`, updateTrackerLeadFinal.rows);
                                            ///////// define dados user
                                            userId = createUser.rows[0].id;
                                            userIdentifierListIds = [createUser.rows[0].id];

                                            console.log(`[x] Lead Criado userId ✅ :`, userId);
                                        }
                                        console.log(`[x] Done ✅ :`, updateTracker.rows[0].id);

                                        const queryRouter = await client.query(
                                            `SELECT * FROM router_tracker WHERE id = $1 AND business_id = $2`,
                                            [queryTracker.rows[0].router_tracker, queryTracker.rows[0].business_id]
                                        );

                                        if(queryRouter.rows.length !== 0 && queryRouter.rows[0].integration_convertion === true){
                                            console.log(`[x] Rota tem integração`);
                                            // adiciona item na fila rabbitmq "tracker_process_integration"
                                            const messageIntegration = {
                                                "tracker_id": queryTracker.rows[0].id
                                            }
                                            const messageIntegrationString = JSON.stringify(messageIntegration);
                                            channel.sendToQueue(QUEUE_NAME_INTEGRATION, Buffer.from(messageIntegrationString));
                                            console.log(`[x] Processo adicionado na fila ${QUEUE_NAME_INTEGRATION}`);
                                        } else {
                                            console.log(`[x] Roteador não encontrado:`, queryRouter.rows.length);
                                        }
                                        if(queryRouter.rows.length !== 0 && queryRouter.rows[0].source_convertion === true){
                                            console.log(`[x] Rota tem integração :`);
                                            // adiciona item na fila rabbitmq "tracker_process_integration"
                                            const messageIntegrationSource = {
                                                "tracker_id": queryTracker.rows[0].id
                                            }
                                            const messageIntegrationSourceString = JSON.stringify(messageIntegrationSource);
                                            channel.sendToQueue(QUEUE_NAME_SOURCE, Buffer.from(messageIntegrationSourceString));
                                            console.log(`[x] Processo adicionado na fila ${QUEUE_NAME_SOURCE}`);
                                        }
                                    }
                                    
                                } else {
                                    console.log(`[x] Tracker não encontrada:`, unicode);
                                    // const queryAllRouterTracker = await client.query(
                                    //     `SELECT * FROM router_tracker WHERE business_id = $1`,
                                    //     [queryGetInstance.rows[0].business_id]
                                    // );
                                    // // verify if contains messageTrigger in list of queryAllRouterTracker.rows.message_trigger
                                    // const containsMessageTrigger = queryAllRouterTracker.rows.some(row => unicode.toString().includes(row.unicode.toString()));
                                    // if (containsMessageTrigger) {
                                    //     // console.log(`[x] Roteador de rastreio encontrado:`, unicode);
                                    // } else {
                                    //     // console.log(`[x] Roteador de rastreio não encontrado:`, unicode);
                                    // }
                                    // console.log(`[x] Rota de rastreio não encontrada!`);
                                }
                            }
                        } else {
                            console.log(`[x] Instância não cadastrada:`, message.instance);
                            channel.ack(msg);
                            return;
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

// Exporta a função consumeMessages
module.exports = {
    consumeMessages
};