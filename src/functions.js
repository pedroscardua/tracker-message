const pool = require('./db/pool');
require('dotenv').config();

/**
 * Consulta registro por ID numérico
 * @param {string} id - ID numérico do registro
 * @returns {Promise} Resultado da consulta
 */
async function queryTrackerByCustomURL(id) {
    try {
        const query = 'SELECT * FROM router_tracker WHERE custom_url = $1';
        const result = await pool.query(query, [id]);
        
        if (result.rows.length === 0) {
            return [];
        }
        
        return result.rows[0];
    } catch (error) {
        console.error('Erro ao consultar por ID:', error);
        throw error;
    }
}

/**
 * Consulta registro por UUID
 * @param {string} uuid - UUID do registro
 * @returns {Promise} Resultado da consulta
 */
async function queryTrackerByUuid(uuid) {
    try {
        const query = 'SELECT * FROM router_tracker WHERE id = $1';
        const result = await pool.query(query, [uuid]);
        
        if (result.rows.length === 0) {
            return [];
        }
        
        return result.rows[0];
    } catch (error) {
        console.error('Erro ao consultar por UUID:', error);
        throw error;
    }
}

/**
 * Seleciona um número de telefone baseado na estratégia definida
 * @param {Array} message_list - Lista de objetos contendo message e tax
 * @param {number} actual_message - Índice da última mensagem usada
 * @param {string} message_type - Tipo de seleção (fix, sequential, percentage)
 * @param {string} tracker_id - ID do tracker para log
 * @returns {string} Mensagem selecionada
 */
async function MessageForTracker(message_list, actual_message, message_type, tracker_id) {
    try {
        if (!message_list || message_list.length === 0) {
            throw new Error('Lista de mensagens vazia ou inválida');
        }

        let selectedMessage;

        switch (message_type) {
            case 'fix':
                selectedMessage = message_list[0].text;
                break;

            case 'sequential':
                const nextIndex = (actual_message + 1) % message_list.length;
                selectedMessage = message_list[nextIndex].text;
                
                await pool.query(
                    'UPDATE router_tracker SET actual_message = $1 WHERE id = $2',
                    [nextIndex, tracker_id]
                );
                break;

            case 'percentage':
                const random = Math.random();
                let accumulatedProbability = 0;

                for (const message of message_list) {
                    accumulatedProbability += message.tax;
                    if (random <= accumulatedProbability) {
                        selectedMessage = message.text;
                        break;
                    }
                }

                if (!selectedMessage) {
                    selectedMessage = message_list[0].text;
                }
                break;

            default:
                throw new Error(`Tipo de seleção inválido: ${message_type}`);
        }

        return selectedMessage;
    } catch (error) {
        console.error('Erro ao selecionar mensagem:', error);
        throw error;
    }
}

/**
 * Seleciona um número de telefone baseado na estratégia definida
 * @param {Array} phone_list - Lista de objetos contendo phone e tax
 * @param {number} actual_phone - Índice do último telefone usado
 * @param {string} phone_type - Tipo de seleção (fix, sequential, percentage)
 * @param {string} tracker_id - ID do tracker para log
 * @returns {string} Número de telefone selecionado
 */
async function PhoneNumberForTracker(phone_list, actual_phone, phone_type, tracker_id) {
    try {
        if (!phone_list || phone_list.length === 0) {
            throw new Error('Lista de telefones vazia ou inválida');
        }

        let selectedPhone;

        switch (phone_type) {
            case 'fix':
                selectedPhone = phone_list[0].phone;
                break;

            case 'sequential':
                const nextIndex = (actual_phone + 1) % phone_list.length;
                selectedPhone = phone_list[nextIndex].phone;
                
                await pool.query(
                    'UPDATE router_tracker SET actual_phone = $1 WHERE id = $2',
                    [nextIndex, tracker_id]
                );
                break;

            case 'percentage':
                const random = Math.random();
                let accumulatedProbability = 0;

                for (const phone of phone_list) {
                    accumulatedProbability += phone.tax;
                    if (random <= accumulatedProbability) {
                        selectedPhone = phone.phone;
                        break;
                    }
                }

                if (!selectedPhone) {
                    selectedPhone = phone_list[0].phone;
                }
                break;

            default:
                throw new Error(`Tipo de seleção inválido: ${phone_type}`);
        }

        return selectedPhone;
    } catch (error) {
        console.error('Erro ao selecionar número de telefone:', error);
        throw error;
    }
}

async function UnicodeForTracker(tracker_id) {
    const ZERO_WIDTH_CHARS = [
        '\u200B',
        '\u200C',
        '\u200D',
        '\u2063'
      ];

    try {
       // gera uma seguencia de 3 a 15 caracteres com os caracteres da lista ZERO_WIDTH_CHARS
       const sequence = [];
       const length = Math.floor(Math.random() * 13) + 3;
       for (let i = 0; i < length; i++) {
        sequence.push(ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)]);
       }
       const unicode = sequence.join('');

       // verifica se o unicode já existe no banco de dados
       const query = 'SELECT * FROM tracker WHERE unicode = $1';
       const result = await pool.query(query, [unicode]);
       if (result.rows.length > 0) {
        return UnicodeForTracker(tracker_id);
       }
       const query_insert = 'UPDATE tracker SET unicode = $2 WHERE id = $1';
       await pool.query(query_insert, [tracker_id, unicode]);
       
       return unicode;
    } catch (error) {
        console.error('Erro ao consultar por UUID:', error);
        throw error;
    }
}

async function createTracker(router_id, businessId, utmCampaign, utmMedium, utmSource, utmContent, ip_user, userAgent) {

    try {
        const query = 'INSERT INTO tracker (router_tracker, business_id, utm_campaign, utm_medium, utm_source, utm_content, client_ip_address, client_user_agent) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *';
        const result = await pool.query(query, [router_id, businessId, utmCampaign, utmMedium, utmSource, utmContent, ip_user, userAgent]);
        return result.rows[0];
    }
    catch (error) {
        console.error('Erro ao criar tracker:', error);
        throw error;
    }
}

async function updateTracker(tracker_id, phone_number, message,message_complete) {

    try {
        const query = 'UPDATE tracker SET router_phone = $2, router_text = $3, full_message = $4 WHERE id = $1';
        await pool.query(query, [tracker_id, phone_number, message, message_complete]);
    }
    catch (error) {
        console.error('Erro ao atualizar tracker:', error);
        throw error;
    }
}

module.exports = {
    queryTrackerByCustomURL,
    queryTrackerByUuid,
    PhoneNumberForTracker,
    MessageForTracker,
    UnicodeForTracker,
    createTracker,
    updateTracker
};
