# StealthSol Threshold ZK Proof Verifier
#
# Distributed verifier with threshold attestation signing.
# Requires 2-of-3 verifiers to agree on proof validity.
# Supports Groth16 proofs via snarkjs.

FROM node:20-alpine

# Install build dependencies for native modules
RUN apk add --no-cache python3 make g++ git curl

WORKDIR /app

# Copy package files
COPY verifier/package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY verifier/threshold-verifier.js ./
COPY verifier/index.js ./index-legacy.js

# Create circuits directory (mounted at runtime)
RUN mkdir -p /app/circuits

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:${PORT:-3001}/health || exit 1

# Environment
ENV NODE_ENV=production
ENV PORT=3001
ENV THRESHOLD_REQUIRED=2

EXPOSE 3001

CMD ["node", "threshold-verifier.js"]
