FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev || npm install --only=prod

COPY . .
ENV NODE_ENV=production

CMD ["node", "index.js"]
