# Use Node.js as base image
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy the rest of the application
COPY . .

# Build the frontend
RUN npm run build

# Expose the port Cloud Run will use
ENV PORT=3000
EXPOSE 3000

# Start the application using tsx as per package.json
CMD ["npm", "start"]
