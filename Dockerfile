FROM node:22-bookworm-slim AS base
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium

FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY web-react/package.json web-react/package-lock.json ./web-react/
RUN npm ci --prefix web-react

FROM base AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web-react/node_modules ./web-react/node_modules
COPY package.json package-lock.json tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY tests ./tests
COPY public ./public
COPY web-react ./web-react
RUN npm run verify
RUN npm run build --prefix web-react

FROM base AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PUBLIC_DIR=/app/web-react/dist
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-react/dist ./web-react/dist
COPY package.json package-lock.json tsconfig.json tsconfig.test.json ./
COPY src ./src
COPY tests ./tests
COPY public ./public
COPY memory ./memory
EXPOSE 3000
CMD ["npm", "run", "serve"]
