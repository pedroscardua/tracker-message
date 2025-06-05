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

async function consumeMessagesIntegration(){
    try {
        const connection = await amqp.connect(RABBITMQ_URL);
        const channel = await connection.createChannel();
        await channel.prefetch(PREFETCH_COUNT);

        console.log(`[x] Consumindo mensagens da fila ${QUEUE_NAME_INTEGRATION}`);

        channel.consume(QUEUE_NAME_INTEGRATION, async (msg) => {
            if (msg !== null) {
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
                            webhook(message);
                            channel.ack(msg);
                            break;
                        default:
                            console.log(`[x] Tipo de integração não suportado:`, queryIntegration.rows[0].type);
                            channel.ack(msg);
                            break;
                    }

                    
            }
        });
    } catch (error) {
        console.error('Erro ao consumir mensagens:', error);
    }
}

consumeMessagesIntegration();


async function webhook(message){
    try{
    const queryTracker = await pool.query(
        `SELECT * FROM tracker WHERE id = $1`,
        [message.tracker_id]
    );

    const queryRouter = await pool.query(
        `SELECT * FROM router_tracker WHERE id = $1`,
        [queryTracker.rows[0].router_tracker]
    );

    const queryLead = await pool.query(
        `SELECT * FROM tracker_leads WHERE id = $1`,
        [queryTracker.rows[0].actual_lead_id]
    );

    const queryIntegration = await pool.query(
        `SELECT * FROM business_integrations WHERE id = $1`,
        [queryRouter.rows[0].integration_id]
    );

    const body = {
        "tracker_id": queryTracker.rows[0],
        "lead_id": queryLead.rows[0],
        "router_id": queryRouter.rows[0]
    }

    //console.log(`[x] Body:`, body);

    const response = await axios.post(queryIntegration.rows[0].custom_webhook, body);
    //console.log(`[x] Response:`, response);
    return;

    } catch (error) {
        console.error('Erro ao consumir mensagens:', error);
    }
}

module.exports = {
    consumeMessagesIntegration
}

