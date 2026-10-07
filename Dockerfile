FROM node:20-alpine

WORKDIR /app

# Copy application files
COPY server.js ./
COPY public/ ./public/
COPY data/ ./data/

# No npm install needed - zero dependencies!

EXPOSE 8080

CMD ["node", "server.js"]
