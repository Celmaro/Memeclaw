# syntax=docker/dockerfile:1
# Memeclaw container image for Zeabur and other PaaS targets.
#
# The desktop build binds loopback only and keeps its state next to the code.
# A container needs the process reachable from the platform proxy and its
# state on a persistent volume, so the three knobs below are the whole
# deployment surface:
#   RADAR_BIND=0.0.0.0        listen on every interface (validated allowlist)
#   PORT=8080                 Zeabur injects the exposed port
#   RADAR_STATE_DIR=/data     point state at the mounted volume
#
# RADAR_TRUSTED_HOSTS is intentionally NOT set here: it must name the exact
# public hostname the operator serves, and an unset value keeps the local
# request gate closed. Set it as a service variable after the domain exists.
FROM node:24-alpine

ENV NODE_ENV=production \
    RADAR_BIND=0.0.0.0 \
    PORT=8080 \
    RADAR_STATE_DIR=/data

WORKDIR /app

# No runtime dependencies, so this layer only materialises the lockfile state.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# Create the mount point so a missing volume surfaces as a normal writable
# directory on first boot instead of a startup crash.
RUN mkdir -p /data && chown -R node:node /app /data

USER node

EXPOSE 8080

# SIGTERM reaches PID 1 directly here, and main.mjs handles it by stopping the
# scanner and closing the server.
STOPSIGNAL SIGTERM

CMD ["npm", "start"]
