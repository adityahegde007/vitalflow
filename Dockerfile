# Stage 1: Build the React frontend
FROM node:20-slim AS build-frontend
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . ./
RUN npm run build

# Stage 2: Build the Python backend and serve the frontend
FROM python:3.10-slim
ENV PYTHONUNBUFFERED True
ENV APP_HOME /app
WORKDIR $APP_HOME

# Install production dependencies.
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy the backend code and the built frontend from Stage 1
COPY . ./
COPY --from=build-frontend /app/dist ./dist

# Run the web service on container startup.
CMD exec uvicorn main:app --host 0.0.0.0 --port 3000
