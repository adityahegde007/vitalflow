# Use Node.js as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm ci

# Copy the rest of the application
COPY . .

# Build the frontend
RUN npm run build

# Production runtime defaults for Cloud Run
ENV NODE_ENV=production
ENV USE_VITE_DEV_SERVER=false
ENV PORT=3000
EXPOSE 3000

# Run as non-root user
USER node

# Start the application using tsx as per package.json
CMD ["npm", "start"]
