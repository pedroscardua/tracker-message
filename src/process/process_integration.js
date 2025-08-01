const pool = require('../db/pool');
const amqp = require('amqplib');
const axios = require('axios');
const dotenv = require('dotenv');

// Carrega as variáveis de ambiente
const result = dotenv.config();
if (result.error) {
    console.error('Erro ao carregar .env:', result.error);
    process.exit(1);
}

const RABBITMQ_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const QUEUE_NAME_INTEGRATION = 'tracker_process_integration';
const PREFETCH_COUNT = process.env.RABBITMQ_PREFETCH_COUNT || 1000;

// Variáveis globais para gerenciamento da conexão
let connection = null;
let channel = null;
let isReconnecting = false;

// Função para fechar conexões graciosamente
async function closeGracefully() {
    console.log('[INTEGRATION] Fechando conexões...');
    try {
        if (channel) {
            await channel.close();
        }
        if (connection) {
            await connection.close();
        }
    } catch (error) {
        console.error('[INTEGRATION] Erro ao fechar conexões:', error);
    } finally {
        process.exit(0);
    }
}

// Registra handlers para fechamento gracioso
process.once('SIGINT', closeGracefully);
process.once('SIGTERM', closeGracefully);

// Função para tentar reconectar
async function attemptReconnection() {
    if (isReconnecting) {
        return;
    }
    
    isReconnecting = true;
    console.log('[INTEGRATION] Tentando reconectar em 5 segundos...');
    
    setTimeout(() => {
        isReconnecting = false;
        consumeMessagesIntegration();
    }, 5000);
}

async function consumeMessagesIntegration(){
    try {
        console.log(`[INTEGRATION] Conectando ao RabbitMQ: ${RABBITMQ_URL}`);
        
        // Configurações de conexão com heartbeat para detectar conexões mortas
        const connectionOptions = {
            heartbeat: 30, // heartbeat a cada 30 segundos
            connection_timeout: 10000, // timeout de 10 segundos para conexão
        };
        
        connection = await amqp.connect(RABBITMQ_URL, connectionOptions);
        channel = await connection.createChannel();
        await channel.prefetch(PREFETCH_COUNT);

        // Configura handler para erros na conexão
        connection.on('error', (error) => {
            console.error('[INTEGRATION] Erro na conexão RabbitMQ:', error);
            if (!isReconnecting) {
                attemptReconnection();
            }
        });

        // Configura handler para fechamento da conexão
        connection.on('close', () => {
            console.log('[INTEGRATION] Conexão RabbitMQ fechada');
            if (!isReconnecting) {
                attemptReconnection();
            }
        });

        // Configura handler para erros no canal
        channel.on('error', (error) => {
            console.error('[INTEGRATION] Erro no canal RabbitMQ:', error);
            if (!isReconnecting) {
                attemptReconnection();
            }
        });

        // Configura handler para fechamento do canal
        channel.on('close', () => {
            console.log('[INTEGRATION] Canal RabbitMQ fechado');
            if (!isReconnecting) {
                attemptReconnection();
            }
        });

        // Declara a fila com configurações de durabilidade
        await channel.assertQueue(QUEUE_NAME_INTEGRATION, {
            durable: true,
            arguments: {
                'x-queue-type': 'quorum', // Usa quorum queue para maior confiabilidade
                'x-delivery-limit': 3 // Máximo de 3 tentativas de entrega
            }
        });

        console.log(`[x] Consumindo mensagens da fila ${QUEUE_NAME_INTEGRATION}`);

        channel.consume(QUEUE_NAME_INTEGRATION, async (msg) => {
            if (msg !== null) {
                try {
                    const message = JSON.parse(msg.content.toString());
                    console.log(`[x] Integração recebida:`, message);

                    const queryTracker = await pool.query(
                        `SELECT * FROM tracker WHERE id = $1`,
                        [message.tracker_id]
                    );

                    if(queryTracker.rows.length === 0){
                        console.log(`[x] Tracker não encontrado:`, message.tracker_id);
                        channel.ack(msg);
                        return;
                    } 
                    console.log(`[x] Tracker encontrado:`, queryTracker.rows[0].id);

                    const queryRouter = await pool.query(
                        `SELECT * FROM router_tracker WHERE id = $1`,
                        [queryTracker.rows[0].router_tracker]
                    );

                    if(queryRouter.rows.length === 0){
                        console.log(`[x] Roteador não encontrado:`, message.tracker_id);
                        channel.ack(msg);
                        return;
                    }

                    console.log(`[x] Roteador encontrado:`, queryRouter.rows[0].id);

                    const queryIntegration = await pool.query(
                        `SELECT * FROM business_integrations WHERE id = $1`,
                        [queryRouter.rows[0].integration_id]
                    );

                    if(queryIntegration.rows.length === 0){
                        console.log(`[x] Integração não encontrada:`, queryRouter.rows[0].integration);
                        channel.ack(msg);
                        return;
                    }

                    console.log(`[x] Integração encontrada:`, queryIntegration.rows[0].id);
                    switch(queryIntegration.rows[0].type){
                        case 'webhook':
                            console.log(`[x] Integração webhook:`, queryIntegration.rows[0].id);
                            await webhook(message);
                            channel.ack(msg);
                            break;
                        default:
                            console.log(`[x] Tipo de integração não suportado:`, queryIntegration.rows[0].type);
                            channel.ack(msg);
                            break;
                    }
                } catch (error) {
                    console.error('[INTEGRATION] Erro ao processar mensagem:', error);
                    // Rejeita a mensagem em caso de erro
                    channel.nack(msg, false, false);
                }
            }
        });
        
        console.log('[INTEGRATION] Conectado com sucesso ao RabbitMQ');
        
    } catch (error) {
        console.error('[INTEGRATION] Erro ao conectar com RabbitMQ:', error);
        if (!isReconnecting) {
            attemptReconnection();
        }
    }
}

// Função para monitorar status da conexão
function logConnectionStatus() {
    const status = {
        connected: connection && !connection.closed,
        channelActive: channel && !channel.closed,
        timestamp: new Date().toISOString()
    };
    
    console.log(`[INTEGRATION] Status da conexão: ${JSON.stringify(status)}`);
}

// Log do status a cada 60 segundos
setInterval(logConnectionStatus, 60000);

// Inicia o consumo
console.log('[INTEGRATION] Iniciando serviço de integração...');
consumeMessagesIntegration();


async function webhook(message){
    try {
        const MAX_RETRIES = 5;
        const DELAY_MS = 1000;

        // Função auxiliar para delay
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

        // Função auxiliar para fazer queries com retry
        async function executeQueryWithRetry(queryFn, retryCount = 0) {
            try {
                const result = await queryFn();
                if (result.rows.length === 0 && retryCount < MAX_RETRIES) {
                    console.log(`Tentativa ${retryCount + 1} falhou, aguardando ${DELAY_MS}ms...`);
                    await delay(DELAY_MS);
                    return executeQueryWithRetry(queryFn, retryCount + 1);
                }
                return result;
            } catch (error) {
                if (retryCount < MAX_RETRIES) {
                    console.log(`Erro na tentativa ${retryCount + 1}, tentando novamente em ${DELAY_MS}ms...`);
                    await delay(DELAY_MS);
                    return executeQueryWithRetry(queryFn, retryCount + 1);
                }
                throw error;
            }
        }

        // Query do Tracker
        const queryTracker = await executeQueryWithRetry(async () => {
            return pool.query(
                `SELECT * FROM tracker WHERE id = $1`,
                [message.tracker_id]
            );
        });

        if (queryTracker.rows.length === 0) {
            console.log(`[x] [INTEGRATION] Tracker não encontrado após ${MAX_RETRIES} tentativas:`, message.tracker_id);
            return;
        }
        //console.log(`[x] [INTEGRATION] ℹ️ Tracker encontrado:`, queryTracker.rows[0]);

        // Query do Router
        const queryRouter = await executeQueryWithRetry(async () => {
            return pool.query(
                `SELECT * FROM router_tracker WHERE id = $1`,
                [queryTracker.rows[0].router_tracker]
            );
        });

        if (queryRouter.rows.length === 0) {
            console.log(`[x] [INTEGRATION] Router não encontrado após ${MAX_RETRIES} tentativas`);
            return;
        }

        // Query do Lead
        const queryLead = await executeQueryWithRetry(async () => {
            return pool.query(
                `SELECT * FROM tracker_leads WHERE id = $1`,
                [queryTracker.rows[0].actual_lead_id]
            );
        });

        if (queryLead.rows.length === 0) {
            console.log(`[x] [INTEGRATION] Lead não encontrado após ${MAX_RETRIES} tentativas; ID LEAD:`, queryTracker.rows[0].actual_lead_id);
            return;
        }

        // Query da Integration
        const queryIntegration = await executeQueryWithRetry(async () => {
            return pool.query(
                `SELECT * FROM business_integrations WHERE id = $1`,
                [queryRouter.rows[0].integration_id]
            );
        });

        if (queryIntegration.rows.length === 0) {
            console.log(`[x] [INTEGRATION] Integration não encontrada após ${MAX_RETRIES} tentativas`);
            return;
        }

        const body = {
            "tracker_id": queryTracker.rows[0],
            "lead_id": queryLead.rows[0],
            "router_id": queryRouter.rows[0]
        }

        // Configurações do axios com timeout e retry
        const webhookConfig = {
            timeout: 30000, // 30 segundos de timeout
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Tracker-Integration/1.0'
            },
            maxRedirects: 3
        };

        // Retry logic para webhook
        const maxWebhookRetries = 3;
        let webhookAttempt = 0;

        while (webhookAttempt < maxWebhookRetries) {
            try {
                const response = await axios.post(queryIntegration.rows[0].custom_webhook, body, webhookConfig);
                console.log(`[x] [INTEGRATION] [WEBHOOK] [${message.tracker_id}] Sent successfully - Status: ${response.status}`);
                return;
            } catch (webhookError) {
                webhookAttempt++;
                console.error(`[x] [INTEGRATION] [WEBHOOK] [${message.tracker_id}] Attempt ${webhookAttempt}/${maxWebhookRetries} failed:`, webhookError.message);
                
                if (webhookAttempt < maxWebhookRetries) {
                    // Delay exponencial: 1s, 2s, 4s
                    const retryDelay = Math.pow(2, webhookAttempt - 1) * 1000;
                    console.log(`[x] [INTEGRATION] [WEBHOOK] [${message.tracker_id}] Retrying in ${retryDelay}ms...`);
                    await delay(retryDelay);
                } else {
                    console.error(`[x] [INTEGRATION] [WEBHOOK] [${message.tracker_id}] All attempts failed. Webhook URL: ${queryIntegration.rows[0].custom_webhook}`);
                    throw webhookError;
                }
            }
        }

    } catch (error) {
        console.error('Erro ao processar webhook:', error);
    }
}

module.exports = {
    consumeMessagesIntegration
}

