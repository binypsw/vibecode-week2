# e-Service กลาง เทศบาลนครก็อตแทม (สมมติ) · Node 20 + Express + SQLite
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# better-sqlite3 ใช้ prebuilt binary · ถ้าดาวน์โหลดไม่ได้จะติดตั้ง toolchain แล้ว build จาก source
RUN npm ci --omit=dev --no-audit --no-fund \
 || (apt-get update \
     && apt-get install -y --no-install-recommends python3 make g++ \
     && rm -rf /var/lib/apt/lists/* \
     && npm ci --omit=dev --no-audit --no-fund --build-from-source)

FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/egov.db \
    TZ=Asia/Bangkok
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
