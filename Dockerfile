# Imagen oficial de Playwright con Chromium y dependencias listas
FROM mcr.microsoft.com/playwright:v1.48.2-jammy

# Workdir
WORKDIR /app

# Solo copiamos package.json para cachear npm ci
COPY package*.json ./

# Instala dependencias de producción
RUN npm install --omit=dev


# Copia el código
COPY . .

# Variables recomendadas
ENV NODE_ENV=production
ENV PORT=10000
# Playwright ya viene instalado con navegadores en esta imagen

# Expone el puerto
EXPOSE 10000

# Arranca el servidor
CMD ["node", "index.js"]
