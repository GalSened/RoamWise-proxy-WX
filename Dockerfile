FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --quiet
COPY server.js ./server.js
ENV NODE_ENV=production
CMD ["npm","start"]
