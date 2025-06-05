const { Pool } = require('pg');
require('dotenv').config();

class DatabasePool {
    constructor() {
        this.retryAttempts = 15;
        this.retryDelay = 1000; // 5 segundos
        this.isReconnecting = false;
        this.reconnectPromise = null;
        this.pool = this.createPool();
        this.setupErrorHandler();
    }

    createPool() {
        return new Pool({
            user: process.env.PGUSER || 'postgres',
            host: process.env.PGHOST || 'localhost',
            database: process.env.PGDATABASE || 'tracker_db',
            password: process.env.PGPASSWORD || 'postgres',
            port: process.env.PGPORT || 5432,
            max: 2000, // número máximo de clientes no pool
            idleTimeoutMillis: 15000, // tempo máximo que um cliente pode ficar ocioso
            connectionTimeoutMillis: 8000, // tempo máximo para estabelecer conexão
            maxRetries: 10, // número máximo de tentativas de reconexão
            keepAlive: true, // mantém a conexão ativa
        });
    }

    setupErrorHandler() {
        this.pool.on('error', (err, client) => {
            console.error('Erro inesperado no cliente do pool:', err);
            if (client) {
                client.release(true);
            }
            this.reconnect();
        });
    }

    async reconnect() {
        if (this.isReconnecting) {
            return this.reconnectPromise;
        }

        this.isReconnecting = true;
        this.reconnectPromise = new Promise(async (resolve) => {
            console.log('Tentando reconectar ao banco de dados...');
            try {
                await this.pool.end();
            } catch (error) {
                console.error('Erro ao encerrar pool existente:', error);
            }

            this.pool = this.createPool();
            this.setupErrorHandler();

            // Testa a conexão
            try {
                await this.pool.query('SELECT 1');
                console.log('Reconexão bem sucedida!');
                this.isReconnecting = false;
                resolve();
            } catch (error) {
                console.error('Falha na reconexão, tentando novamente...');
                setTimeout(() => {
                    this.isReconnecting = false;
                    this.reconnect().then(resolve);
                }, this.retryDelay);
            }
        });

        return this.reconnectPromise;
    }

    async query(text, params, retryCount = 0) {
        try {
            // Se estiver reconectando, aguarda a reconexão
            if (this.isReconnecting) {
                await this.reconnectPromise;
            }

            const result = await this.pool.query(text, params);
            return result;
        } catch (error) {
            if (error.message.includes('Connection terminated') || this.isRetryableError(error)) {
                if (retryCount < this.retryAttempts) {
                    console.log(`Tentativa ${retryCount + 1} de ${this.retryAttempts}. Aguardando reconexão...`);
                    await this.reconnect();
                    return this.query(text, params, retryCount + 1);
                }
            }
            throw error;
        }
    }

    isRetryableError(error) {
        const retryableCodes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'];
        return retryableCodes.includes(error.code);
    }

    async getClient() {
        const client = await this.pool.connect();
        const query = client.query.bind(client);
        const release = client.release.bind(client);

        // Sobrescreve a função query para adicionar retry
        client.query = async (text, params, retryCount = 0) => {
            try {
                return await query(text, params);
            } catch (error) {
                if (this.isRetryableError(error) && retryCount < this.retryAttempts) {
                    console.log(`Tentativa ${retryCount + 1} de ${this.retryAttempts} falhou. Tentando novamente em ${this.retryDelay/1000} segundos...`);
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                    return client.query(text, params, retryCount + 1);
                }
                throw error;
            }
        };

        // Sobrescreve a função release para garantir que o cliente seja liberado corretamente
        client.release = () => {
            release(true);
        };

        return client;
    }
}

// Exporta uma única instância do pool
module.exports = new DatabasePool(); 