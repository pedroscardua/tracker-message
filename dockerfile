# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM imbios/bun-node:latest AS base
WORKDIR /usr/src/app

# install dependencies into temp directory
# this will cache them and speed up future builds
FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json .env /temp/dev/
RUN cd /temp/dev && bun install

# install with --production (exclude devDependencies)
RUN mkdir -p /temp/prod
COPY package.json .env /temp/prod/
RUN cd /temp/prod && bun install --production

# if erro: rm bun.lockb
# after: bun install


# copy production dependencies and source code into final image
FROM base AS release
ENV NODE_ENV=production
COPY --from=install /temp/prod/node_modules node_modules
COPY . .
COPY .env .
ENV BUN_JSC_forceRAMSize="1073741"

ENTRYPOINT [ "bun", "run", "--smol", "/usr/src/app/index.js" ]
