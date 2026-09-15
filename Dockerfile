FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install --include=dev
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
RUN npm install --global supergateway@3.4.3
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY railway-http.mjs ./railway-http.mjs
ENV PORT=3000
EXPOSE 3000
CMD ["node", "railway-http.mjs"]
