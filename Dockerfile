# Set the base image
FROM node:20-bookworm-slim

# WORKDIR /usr/src/app/
WORKDIR /home/gateway

# Create mount points
RUN mkdir -p    /home/gateway/conf \
                /home/gateway/conf/chains \
                /home/gateway/conf/connectors \
                /home/gateway/conf/namespace \
                /home/gateway/conf/pools \
                /home/gateway/conf/rpc \
                /home/gateway/conf/tokens \
                /home/gateway/conf/wallets \
                /home/gateway/logs \
                /home/gateway/certs

# Install pnpm — pinned (was pnpm@latest, which drifted to a Node-22-requiring
# release and broke `pnpm install` on the node:20 base with ERR_UNKNOWN_BUILTIN_MODULE
# 2026-06-03). 10.28.2 satisfies package.json engines pnpm ^10.10.0 + lockfile 9.0.
RUN npm install -g pnpm@10.28.2

# Copy package files first
COPY package.json pnpm-lock.yaml ./

# Dockerfile author / maintainer
LABEL maintainer="Michael Feng <mike@hummingbot.org>"

# Build arguments
ARG BRANCH
ARG COMMIT
ARG BUILD_DATE

# Labels using build args
LABEL branch=${BRANCH}
LABEL commit=${COMMIT}
LABEL date=${BUILD_DATE}

# Set ENV variables
ENV COMMIT_BRANCH=${BRANCH}
ENV COMMIT_SHA=${COMMIT}
ENV BUILD_DATE=${BUILD_DATE}
ENV INSTALLATION_TYPE=docker
ENV DEV=true

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy the rest of the files
COPY . .

# Build
RUN pnpm build

# Create necessary conf directories

# Expose default port and Swagger UI on http://localhost:15888/docs
EXPOSE 15888

# Set the default command to run when starting the container
CMD ["sh", "-c", "if [ \"$DEV\" = \"true\" ]; then pnpm start --dev; else pnpm start; fi"]
