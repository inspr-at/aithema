FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node . .
RUN npm ci --omit=dev && mkdir -p /data && chown node:node /data
USER node
ENV AITHEMA_DB=/data/session.sqlite AITHEMA_LISTEN_HOST=0.0.0.0 PORT=3000
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD node --input-type=module -e "const origin = process.env.AITHEMA_PUBLIC_ORIGIN; const r = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz', { headers: origin ? { host: new URL(origin).host } : {}, signal: AbortSignal.timeout(4000) }); process.exit(r.ok && (await r.json()).ok === true ? 0 : 1)"
CMD ["node", "demo/server.js"]
