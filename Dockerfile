# syntax=docker/dockerfile:1
# Drop-in Dockerfile for K18to21Election2 (requires output: 'standalone' in next.config.ts).

# ---------- deps ----------
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# ---------- builder ----------
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# SYNC_FROM_BIGQUERY=1 makes `npm run build` (prebuild hook) regenerate summaries/*.json
# from BigQuery. Cloud Build supplies credentials via the build service account.
ARG SYNC_FROM_BIGQUERY=0
ARG GCP_PROJECT
ARG BQ_DATASET=electoral_hub
ENV SYNC_FROM_BIGQUERY=$SYNC_FROM_BIGQUERY GCP_PROJECT=$GCP_PROJECT BQ_DATASET=$BQ_DATASET
RUN npm run build

# ---------- runner ----------
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Cloud Run injects $PORT (default 8080); Next standalone server.js honors it.
ENV PORT=8080
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# page.tsx reads reports/*.md with fs at render time
COPY --from=builder --chown=nextjs:nodejs /app/reports ./reports
USER nextjs
EXPOSE 8080
CMD ["node", "server.js"]
