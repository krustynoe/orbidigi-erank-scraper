FROM mcr.microsoft.com/playwright:v1.56.1-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --only=prod
COPY . .
CMD ["node","index.js"]
