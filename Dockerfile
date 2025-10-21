# Usa Node 20 (recomendado pelo Google Cloud)
FROM node:20

# Cria diretório e copia arquivos
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

# Expõe a porta 8080 (requisito do Cloud Run)
EXPOSE 8080

# Comando de inicialização
CMD ["npm", "start"]
