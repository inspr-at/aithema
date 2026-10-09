# OPS pins NODE_IMAGE to node:24-bookworm-slim@sha256:<digest> at build time.
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /app
COPY --chown=root:root . .
RUN npm ci --omit=dev && chmod -R a-w /app && mkdir -p /data && chown node:node /data
USER node
ENV AITHEMA_DB=/data/session.sqlite AITHEMA_LISTEN_HOST=0.0.0.0 PORT=3000
VOLUME ["/data"]
EXPOSE 3000
# node:http sends the allowed Host explicitly; the server keeps its Host gate.
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD ["node", "scripts/healthcheck.js"]
CMD ["node", "demo/server.js"]
