FROM node:24-bookworm-slim

WORKDIR /app
ENV NODE_ENV=development

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run db:generate

EXPOSE 3000
CMD ["npm", "run", "dev"]
