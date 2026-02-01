# StealthSol CoinJoin Coordinator
#
# Distributed coordinator node for blind CoinJoin protocol.
# Uses threshold RSA for distributed signatures.

FROM node:20-alpine

# Install build dependencies
RUN apk add --no-cache python3 make g++ git

WORKDIR /app

# Copy package files
COPY coinjoin/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY coinjoin/src ./src
COPY coinjoin/tsconfig.json ./

# Build TypeScript
RUN npm run build

# Create data directory
RUN mkdir -p /app/data

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -q --spider http://localhost:${PORT:-8080}/health || exit 1

# Environment variables
ENV NODE_ENV=production
ENV PORT=8080

# Expose port
EXPOSE 8080

# Start the distributed coordinator
CMD ["node", "dist/distributed/distributed-server.js"]
