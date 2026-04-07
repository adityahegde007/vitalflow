# VitalFlow MVP

VitalFlow is a multi-agent healthcare orchestration system designed to manage patient recovery protocols, schedule follow-ups, and maintain clinical context using Gemini 3.1 Flash and AlloyDB.

## Features

- **Multi-Persona Interface**: Orchestrator, Clinical Analyst, and Logistics Officer.
- **Contextual Memory**: Recalls patient history and symptoms using `get_action_logs`.
- **Real-time Monitoring**: Live context feed and audit trails.
- **Cloud-Native**: Designed for Google Cloud Run with AlloyDB integration.

## Deployment to Google Cloud Run

### Option 1: Direct Source Deployment (Recommended)

This is the easiest way to deploy. Google Cloud will automatically build the container for you using the `Dockerfile`.

1.  **Install Google Cloud SDK**: [Install gcloud](https://cloud.google.com/sdk/docs/install).
2.  **Initialize Project**:
    ```bash
    gcloud init
    gcloud auth login
    ```
3.  **Deploy**:
    ```bash
    gcloud run deploy vitalflow \
      --source . \
      --region us-central1 \
      --allow-unauthenticated \
      --set-env-vars="GEMINI_API_KEY=your_api_key_here"
    ```

### Option 2: Docker Deployment

1.  **Build the Image**:
    ```bash
    docker build -t gcr.io/[PROJECT_ID]/vitalflow .
    ```
2.  **Push to Artifact Registry**:
    ```bash
    docker push gcr.io/[PROJECT_ID]/vitalflow
    ```
3.  **Deploy to Cloud Run**:
    ```bash
    gcloud run deploy vitalflow \
      --image gcr.io/[PROJECT_ID]/vitalflow \
      --platform managed \
      --region us-central1 \
      --allow-unauthenticated
    ```

## "No Cost" (Free Tier) Strategy

To run this application within the Google Cloud Free Tier:

1.  **Cloud Run**: The first 2 million requests per month are free. Ensure you set "Min instances" to 0 so you don't pay for idle time.
2.  **Artifact Registry**: 500MB of storage is free.
3.  **Database (Crucial)**:
    - **AlloyDB** does NOT have a free tier.
    - **Zero Cost**: The application automatically falls back to **SQLite** if no database URL is provided. Note that SQLite data is ephemeral on Cloud Run (it resets on every restart).
    - **Low Cost/Free Tier Alternative**: Use a free-tier PostgreSQL instance from providers like **Supabase** or **Neon**, and set the `DATABASE_URL` environment variable in Cloud Run.

## Environment Variables

- `GEMINI_API_KEY`: Your Google AI Studio API key.
- `DATABASE_URL`: PostgreSQL connection string (optional, falls back to SQLite).
- `GOOGLE_CLOUD_PROJECT`: Your GCP Project ID.
- `GOOGLE_CLOUD_REGION`: Your GCP Region (e.g., `us-central1`).
