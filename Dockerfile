
FROM node:20-alpine

WORKDIR /app

# Copy package files first
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose application port
EXPOSE 3000

# Run as non-root user
USER node

# Start application
CMD ["node", "server.js"]
