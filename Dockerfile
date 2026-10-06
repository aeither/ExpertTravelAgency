FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 DATA_PATH=/data/origin.sqlite
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
CMD ["node", "dist/server.js"]
