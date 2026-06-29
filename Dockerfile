FROM node:20-alpine
WORKDIR /app
COPY package.json ./
COPY proxy-server.js ./
EXPOSE 3001
CMD ["node", "proxy-server.js"]
