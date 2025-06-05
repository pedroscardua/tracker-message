const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { consumeMessages } = require('./process/process_messages');
const { consumeMessagesIntegration } = require('./process/process_integration');
require('dotenv').config();

const app = express();
const trackerRoutes = require('./recive_tracker');

// Middlewares
app.use(cors());
app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rota básica de teste
app.get('/', (req, res) => {
    res.json({ message: 'API está funcionando!' });
});

// Rota do tracker
app.use('/c', trackerRoutes);

// Tratamento de erros
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Algo deu errado!' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
   
    // Inicia o consumidor de mensagens
    try {
        consumeMessages();
        consumeMessagesIntegration();
        console.log('Consumidor de mensagens RabbitMQ iniciado');
    } catch (error) {
        console.error('Erro ao iniciar consumidor de mensagens:', error);
    }
}); 