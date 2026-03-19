FROM node:20-alpine
WORKDIR /app
COPY package*.json ./

COPY prisma ./prisma/
RUN npm install --only=production
COPY . .
EXPOSE 8082

CMD ["node", "src/app.js"]