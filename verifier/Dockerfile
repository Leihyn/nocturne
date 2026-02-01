# StealthSol ZK Verifier Service
# Production Docker image

FROM node:20-slim

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY index.js ./

# Create non-root user for security
RUN useradd -r -u 1001 verifier
USER verifier

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Start the service
CMD ["node", "index.js"]
