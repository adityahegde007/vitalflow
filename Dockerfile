# Use Python 3.10 as base image
FROM python:3.10-slim

# Install Node.js for building the frontend
RUN apt-get update && apt-get install -y \
    curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy package files and install dependencies
COPY package*.json ./
RUN npm install

# Copy requirements and install Python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the application
COPY . .

# Build the frontend
RUN npm run build

# Expose the port Cloud Run will use
ENV PORT 8080
EXPOSE 8080

# Start the application
# We use uvicorn directly to serve the FastAPI app which also serves the static files
CMD ["python3", "main.py"]
