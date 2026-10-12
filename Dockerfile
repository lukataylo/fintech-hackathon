FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production DB_PATH=/data/hackathon.db
COPY package.json server.mjs ./
COPY public ./public
EXPOSE 3000
CMD ["node", "server.mjs"]
