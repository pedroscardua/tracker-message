# Use a imagem oficial do Node.js
FROM node:20-alpine AS base
WORKDIR /usr/src/app

# Instalar dependências em diretório temporário
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json package-lock.json /temp/dev/
RUN cd /temp/dev && npm ci

# Instalar dependências de produção
RUN mkdir -p /temp/prod
COPY package.json package-lock.json /temp/prod/
RUN cd /temp/prod && npm ci --only=production

# Copiar dependências de produção e código fonte para a imagem final
FROM base AS release
ENV NODE_ENV=production

# Copiar arquivos do projeto
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

# Expor a porta (adicione a porta que seu aplicativo usa)
EXPOSE 3000

# Comando para iniciar o aplicativo
CMD ["node", "src/server.js"]
