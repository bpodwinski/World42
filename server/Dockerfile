FROM node:16-alpine

WORKDIR /app

# Copie des fichiers de dépendances et installation
RUN npm install express socket.io cors

# Copie du code source
COPY . .

# Expose le port 3000 (celui utilisé par le serveur)
EXPOSE 8888

CMD ["node", "chunkServer.js"]
