FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY . .

RUN npm run build

FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=build /app/server ./server
COPY configs ./configs
COPY client/public ./client/public

EXPOSE 4000

CMD ["node", "server/index.js"]
