# --- build: compile TS → dist, then drop dev deps ---
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- runtime: prod deps + compiled JS only ---
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# Daily SQLite files nest under this dir as YYYY/MM/regby-YYYY-MM-DD.db.
ENV REGBY_DB_PATH=/data/regby.db
COPY package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
VOLUME /data
CMD ["node", "dist/index.js"]
