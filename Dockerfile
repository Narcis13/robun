FROM oven/bun:1-alpine

WORKDIR /app

# Install git (needed for some tools)
RUN apk add --no-cache git

# Copy package files first (cached layer)
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY tsconfig.json ./

# Create data directory
RUN mkdir -p /root/.robun

EXPOSE 18790

ENTRYPOINT ["bun", "run", "src/index.ts"]
CMD ["status"]
