FROM mcr.microsoft.com/playwright:v1.56.1-jammy

WORKDIR /app
# copia package.json y package-lock.json primero para cachear la capa de dependencias
COPY package*.json ./
RUN npm ci --omit=dev

# ahora el resto del código
COPY . .

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV PORT=10000
EXPOSE 10000

CMD ["node", "index.js"]
