// Configuração inicial
import express from 'express';
import pkg from 'pg';
const { Pool } = pkg;
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import axios from 'axios';
import CryptoJS from 'crypto-js';
import messagesRouter from './messages_process.js';
import { CHARSToString } from './messages_process.js';

// Carregar variáveis de ambiente
dotenv.config();

// Inicializar aplicação Express
const app = express();

// Middlewares
app.use(helmet()); // Segurança
app.use(cors()); // Habilitar CORS
app.use(morgan('combined')); // Logging
app.use(express.json());

// Usar o router de mensagens
app.use('/api', messagesRouter);

// Configuração do PostgreSQL
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
            }, 5000); // Tenta reconectar após 5 segundos
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

// Caracteres especiais para geração do código único (caracteres invisíveis reais)
const ZERO_WIDTH_CHARS = [
  '\u200B', // ZERO WIDTH SPACE
  '\u200C', // ZERO WIDTH NON-JOINER
  '\u200D'  // ZERO WIDTH JOINER
];

const generateUniqueCode = async (text) => {
  // Converter o texto para um array de caracteres
  const chars = text.split('');
  
  // Determinar número de caracteres invisíveis a inserir (entre 3 e 10)
  const numInvisibleChars = Math.floor(Math.random() * 8) + 3;
  
  // Inserir caracteres invisíveis em posições aleatórias
  for (let i = 0; i < numInvisibleChars; i++) {
    // Selecionar um caractere aleatório da lista
    const randomChar = ZERO_WIDTH_CHARS[Math.floor(Math.random() * ZERO_WIDTH_CHARS.length)];
    
    // Inserir em uma posição aleatória
    const position = Math.floor(Math.random() * (chars.length + 1));
    chars.splice(position, 0, randomChar);
  }
  
  // Juntar os caracteres novamente em uma string
  const uniqueCode = chars.join('');
  
  // Verificar se o código já existe no banco
  const client = await pool.connect();
  try {
    const result = await client.query(
      'SELECT COUNT(*) FROM tracker WHERE unique_code = $1',
      [uniqueCode]
    );
    
    // Se já existir, gerar outro código recursivamente
    if (parseInt(result.rows[0].count) > 0) {
      return generateUniqueCode(text);
    }
    
    return uniqueCode;
  } finally {
    client.release();
  }
};

const sha256 = (text) => {
  return CryptoJS.SHA256(text).toString();
};
export { sha256 };

// Rota para criar um novo rastreamento
app.get('/c/:number', async (req, res) => {
  try {
    const { number } = req.params;
    const { 
      text, 
      business: businessId, 
      utm_campaign: utmCampaign, 
      utm_medium: utmMedium, 
      utm_source: utmSource, 
      utm_content: utmContent 
    } = req.query;

    const ip_user = req.headers['x-forwarded-for']?.split(',')[0] || req.ip;
    const userAgent = req.headers['user-agent'];
    
    // Validar parâmetros obrigatórios
    if (!number || !text || !businessId) {
      return res.status(400).json({ error: 'Ops, não foi possível processar a requisição. Por favor, tente novamente.' });
    }
    
    // Gerar código único
    const uniqueCode = await generateUniqueCode(text);
    const uniqueCodeString = await CHARSToString(uniqueCode);
    
    // Inserir no banco de dados
    const client = await pool.connect();
    try {
      const resultTracker = await client.query(
        `INSERT INTO tracker 
         (number_destination, text, business_id, utm_campaign, utm_medium, utm_source, utm_content, unique_code, client_ip_address, client_user_agent, unique_code_decoded) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
        [number, text, businessId, utmCampaign, utmMedium, utmSource, utmContent, uniqueCode, ip_user, userAgent, uniqueCodeString]
      );
      
      // Redirecionar para o WhatsApp
      const redirectUrl = `https://wa.me/${number}?text=${uniqueCode}`;
      res.redirect(redirectUrl);

      try {
        console.log('>>>> Mensagem:', text);
        const queryGetTrigger = await client.query(
          `SELECT * FROM router_tracker WHERE business_id = $1 AND message_trigger = $2`,
          [businessId, text]
        );

        if (queryGetTrigger.rows.length > 0) {
          console.log('>>>> Trigger encontrado:', queryGetTrigger.rows[0]?.message_trigger);
          const createUserIdentifier = await client.query(
            `INSERT INTO tracker_user_identifier (business_id) VALUES ($1) RETURNING *`,
            [businessId]
          );

          try {
            await client.query(
              `UPDATE tracker SET router_tracker_id = $1, user_identifier_id = $2, internal_source = $3 WHERE id = $4`,
              [queryGetTrigger.rows[0].id, createUserIdentifier.rows[0].id, queryGetTrigger.rows[0].internal_source, resultTracker.rows[0].id]
            );

            await client.query(
              `UPDATE tracker_user_identifier SET tracker_id = $1 WHERE id = $2`,
              [resultTracker.rows[0].id, createUserIdentifier.rows[0].id]
            );
          } catch (error) {
            console.error('Erro ao atualizar tracker ou user_identifier:', error);
          }

          if (queryGetTrigger.rows[0].internal_source === 'pinterest') {
            try {
              const queryGetPinterest = await client.query(
                `SELECT * FROM sources WHERE id = $1`,
                [queryGetTrigger.rows[0].internal_source_id]
              );

              if (queryGetPinterest.rows.length > 0 && queryGetPinterest.rows[0].paramters !== null) {
                  const parameters = queryGetPinterest.rows[0].paramters;
                  const parametersMap = new Map(Object.entries(parameters));
                  const pinterestToken = parametersMap.get('convertion_token');
                  const adAccountId = parametersMap.get('ad_account_id');

                  const data = {
                    "data": [
                      {
                        "action_source": "offline",
                        "event_id": resultTracker.rows[0].id,
                        "event_name": "page_visit",
                        "event_time": parseInt(Date.now() / 1000),
                        "user_data": {
                          "client_ip_address": ip_user,
                          "client_user_agent": userAgent,
                          "external_id": [sha256(createUserIdentifier.rows[0].id)]
                        },
                        "custom_data": {
                          "content_ids": [queryGetTrigger.rows[0].product_id]
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
            } catch (error) {
              console.error('Erro ao buscar dados do Pinterest:', error);
            }
          }
        } else {
          console.log('>>>> Trigger não encontrado:', text);
        }
      } catch (error) {
        console.error('Erro ao processar trigger:', error);
      }
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao processar requisição:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno do servidor' });
    }
  }
});

// Rota para estatísticas (opcional)
app.get('/stats', async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT 
          COUNT(*) as total_clicks,
          COUNT(DISTINCT number) as unique_numbers,
          COUNT(DISTINCT business_id) as unique_businesses,
          COUNT(DISTINCT utm_source) as unique_sources
        FROM tracker`
      );
      
      return res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (error) {
    console.error('Erro ao buscar estatísticas:', error);
    return res.status(500).json({ error: 'Erro interno do servidor' });
  }
});

// Iniciar o servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});

export { ZERO_WIDTH_CHARS };
export default app;