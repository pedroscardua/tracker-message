# Tracker V2 API

Sistema de API Node.js com Express

## Requisitos

- Node.js
- npm ou yarn

## Instalação

1. Clone o repositório
2. Instale as dependências:
```bash
npm install
```

3. Crie um arquivo `.env` na raiz do projeto com as seguintes variáveis:
```
PORT=3000
NODE_ENV=development
```

## Executando o projeto

### Desenvolvimento
```bash
npm run dev
```

### Produção
```bash
npm start
```

## Testes
```bash
npm test
```

## Estrutura do Projeto

- `src/server.js` - Arquivo principal do servidor
- `.env` - Variáveis de ambiente
- `package.json` - Dependências e scripts

## Endpoints

- GET `/` - Rota de teste da API 