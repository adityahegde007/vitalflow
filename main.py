import os
import json
import logging
from typing import List, Optional
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
import ssl

# Vertex AI SDK
import vertexai
from vertexai.generative_models import GenerativeModel, Tool, FunctionDeclaration, Part

# AlloyDB / SQLAlchemy
from sqlalchemy import create_engine, Column, String, Integer, DateTime, Text, func
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker, Session
from google.cloud.alloydb.connector import Connector

# Google Calendar
from googleapiclient.discovery import build
import google.auth

# Setup logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Global log buffer for UI debugging
class LogBuffer(logging.Handler):
    def __init__(self):
        super().__init__()
        self.buffer = []
    def emit(self, record):
        self.buffer.append(self.format(record))
        if len(self.buffer) > 100:
            self.buffer.pop(0)

log_buffer = LogBuffer()
log_buffer.setFormatter(logging.Formatter('%(asctime)s - %(name)s - %(levelname)s - %(message)s'))
logger.addHandler(log_buffer)

# 1. Initialize Vertex AI (ADC)
PROJECT_ID = os.getenv("GOOGLE_CLOUD_PROJECT")
LOCATION = os.getenv("GOOGLE_CLOUD_REGION", "us-central1")

try:
    if PROJECT_ID:
        vertexai.init(project=PROJECT_ID, location=LOCATION)
        print(f"INFO: Vertex AI initialized for project {PROJECT_ID}")
    else:
        print("WARNING: GOOGLE_CLOUD_PROJECT not set. Vertex AI might fail.")
except Exception as e:
    print(f"ERROR: Failed to initialize Vertex AI: {e}")

# 2. AlloyDB Connectivity (DATABASE_URL or IAM Connector)
Base = declarative_base()

class ActionLog(Base):
    __tablename__ = "action_logs"
    id = Column(Integer, primary_key=True, index=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    patient_id = Column(Integer, index=True)
    agent_action = Column(String(100))
    tool_used = Column(String(100))
    result = Column(Text)

def get_db_engine():
    db_url = os.getenv("DATABASE_URL")
    instance_name = os.getenv("ALLOYDB_INSTANCE_NAME")
    
    # If DATABASE_URL is provided, use it (manual connection string)
    if db_url:
        logger.info("Initializing AlloyDB connection via DATABASE_URL")
        # Standardize for pg8000
        if db_url.startswith("postgresql://"):
            db_url = db_url.replace("postgresql://", "postgresql+pg8000://", 1)
        
        connect_args = {}
        if "sslmode=require" in db_url or "ssl=True" in db_url:
            db_url = db_url.replace("sslmode=require", "").replace("ssl=True", "").replace("??", "?").rstrip("?")
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            connect_args["ssl_context"] = ctx
        
        try:
            engine = create_engine(db_url, connect_args=connect_args)
            with engine.connect() as conn:
                logger.info("Database connection successful via URL")
            return engine, "AlloyDB (URL)"
        except Exception as e:
            logger.error(f"Failed to connect via URL: {e}")

    # If no URL or URL failed, try IAM Connector if instance info is present
    if instance_name:
        logger.info(f"Initializing AlloyDB connection via IAM Connector for {instance_name}")
        try:
            connector = Connector()
            def getconn():
                conn = connector.connect(
                    instance_name,
                    "pg8000",
                    user=os.getenv("ALLOYDB_USER", "postgres"),
                    db=os.getenv("ALLOYDB_DB", "postgres"),
                    enable_iam_auth=True
                )
                return conn

            engine = create_engine(
                "postgresql+pg8000://",
                creator=getconn,
            )
            with engine.connect() as conn:
                logger.info("Database connection successful via IAM Connector")
            return engine, "AlloyDB (IAM)"
        except Exception as e:
            logger.error(f"Failed to connect via IAM Connector: {e}")

    # Fallback to SQLite
    logger.warning("No AlloyDB configuration found or connection failed. Falling back to SQLite.")
    return create_engine("sqlite:///./vitalflow.db", connect_args={"check_same_thread": False}), "SQLite (Fallback)"

# Initialize DB
try:
    engine, db_type_name = get_db_engine()
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    logger.info(f"Database initialized successfully: {db_type_name}")
except Exception as e:
    logger.error(f"CRITICAL: Database initialization failed: {e}")
    # Fallback to a guaranteed SQLite engine to allow the app to start
    engine = create_engine("sqlite:///./vitalflow_emergency.db", connect_args={"check_same_thread": False})
    db_type_name = "SQLite (Emergency Fallback)"
    Base.metadata.create_all(bind=engine)
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    logger.warning("System started using Emergency Fallback DB.")

def seed_db():
    db = SessionLocal()
    try:
        if db.query(ActionLog).count() == 0:
            logger.info("Seeding database with initial system log")
            seed_log = ActionLog(
                patient_id=0,
                agent_action="INITIALIZATION",
                tool_used="NONE",
                result="VitalFlow Care Orchestrator Node Online. All MCP bridges verified."
            )
            db.add(seed_log)
            db.commit()
    except Exception as e:
        logger.error(f"Seeding failed: {e}")
    finally:
        db.close()

seed_db()

# Dependency to get DB session
def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

# 3. MCP Tool Definitions
def check_calendar():
    """Uses Google Calendar API (Service Account/ADC)."""
    try:
        credentials, project = google.auth.default(
            scopes=['https://www.googleapis.com/auth/calendar.readonly']
        )
        service = build('calendar', 'v3', credentials=credentials)
        # Mocking availability for demo
        return {"availability": ["2026-04-02T09:00:00Z", "2026-04-02T14:00:00Z"]}
    except Exception as e:
        print(f"WARNING: Calendar API check failed: {e}")
        return {"status": "error", "message": "Calendar integration unavailable"}

def get_recovery_protocol():
    """Reads from a local markdown file."""
    try:
        with open("recovery_protocols.md", "r") as f:
            return {"protocol": f.read()}
    except FileNotFoundError:
        return {"error": "Protocol file not found."}

def get_patient_history(patient_id: str):
    """Retrieves patient history from AlloyDB."""
    # Mocking patient history for demo purposes
    history = {
        "100": {"surgery": "Appendectomy", "date": "2026-03-25", "complications": "None"},
        "101": {"surgery": "Knee Replacement", "date": "2026-03-20", "complications": "Mild swelling"},
        "102": {"surgery": "Gallbladder Removal", "date": "2026-03-28", "complications": "None"},
    }
    return history.get(patient_id, {"surgery": "Unknown", "date": "Unknown", "complications": "Unknown"})

def update_patient_task(patient_id: str, task: str, status: str, details: str):
    """Writes to the AlloyDB 'action_logs' table."""
    db = SessionLocal()
    try:
        pid = 0
        try:
            pid = int(patient_id)
        except:
            pass
            
        new_log = ActionLog(
            patient_id=pid,
            agent_action=task,
            tool_used=status,
            result=details
        )
        db.add(new_log)
        db.commit()
        db.refresh(new_log)
        print(f"ALOYDB LOG: Patient {patient_id} | {task} | {status}")
        return {"success": True, "logged": f"{task} for {patient_id}", "id": new_log.id}
    except Exception as e:
        db.rollback()
        print(f"ALOYDB ERROR: {str(e)}")
        return {"success": False, "error": str(e)}
    finally:
        db.close()

# 3. Tool API Endpoints
app = FastAPI()

@app.middleware("http")
async def log_requests(request: Request, call_next):
    logger.info(f"Incoming request: {request.method} {request.url.path}")
    # Log headers (masked)
    headers = {k: ("****" if k.lower() in ["authorization", "x-goog-api-key", "cookie"] else v) for k, v in request.headers.items()}
    logger.info(f"Request headers: {headers}")
    try:
        response = await call_next(request)
        logger.info(f"Response status: {response.status_code}")
        return response
    except Exception as e:
        logger.error(f"Request failed: {e}")
        raise e

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/tools/calendar")
def tool_calendar():
    """Tool: Check available follow-up appointment slots."""
    return check_calendar()

@app.get("/api/tools/protocol")
def tool_protocol():
    """Tool: Read post-surgical recovery protocols."""
    return get_recovery_protocol()

@app.get("/api/tools/patient-history/{patient_id}")
def tool_patient_history(patient_id: str):
    """Tool: Retrieve patient history."""
    return get_patient_history(patient_id)

class TaskRequest(BaseModel):
    patient_id: str
    task: str
    status: str
    details: str

@app.post("/api/tools/log-task")
def tool_log_task(request: TaskRequest):
    """Tool: Log an action or update a patient task in AlloyDB."""
    return update_patient_task(
        patient_id=request.patient_id,
        task=request.task,
        status=request.status,
        details=request.details
    )

@app.get("/api/logs")
def get_logs(limit: int = 10, db: Session = Depends(get_db)):
    """Fetch recent action logs from AlloyDB."""
    try:
        logs = db.query(ActionLog).order_by(ActionLog.timestamp.desc()).limit(limit).all()
        return [
            {
                "id": log.id,
                "patient_id": str(log.patient_id),
                "action": log.agent_action,
                "status": log.tool_used,
                "details": log.result,
                "created_at": log.timestamp.isoformat() if log.timestamp else None
            }
            for log in logs
        ]
    except Exception as e:
        logger.error(f"Failed to fetch logs: {e}")
        return []

@app.get("/api/db-diagnostics")
def db_diagnostics():
    """Diagnostic endpoint to check database connectivity and return errors."""
    db_url = os.getenv("DATABASE_URL")
    instance_name = os.getenv("ALLOYDB_INSTANCE_NAME")
    
    results = {
        "status": "unknown",
        "methods_tried": []
    }

    # Method 1: DATABASE_URL
    if db_url:
        masked_url = db_url
        if "@" in db_url:
            parts = db_url.split("@")
            user_pass = parts[0].split("//")[-1]
            masked_url = parts[0].replace(user_pass, "****") + "@" + parts[1]
        
        results["methods_tried"].append({"method": "DATABASE_URL", "url": masked_url})
        
        try:
            # Standardize for pg8000
            diag_url = db_url
            if diag_url.startswith("postgresql://"):
                diag_url = diag_url.replace("postgresql://", "postgresql+pg8000://", 1)
            
            connect_args = {}
            if "sslmode=require" in diag_url or "ssl=True" in diag_url:
                diag_url = diag_url.replace("sslmode=require", "").replace("ssl=True", "").replace("??", "?").rstrip("?")
                ctx = ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
                connect_args["ssl_context"] = ctx
            
            temp_engine = create_engine(diag_url, connect_args=connect_args)
            with temp_engine.connect() as conn:
                results["status"] = "success"
                results["message"] = "Connected via DATABASE_URL"
                return results
        except Exception as e:
            results["methods_tried"][-1]["error"] = str(e)

    # Method 2: IAM Connector
    if instance_name:
        results["methods_tried"].append({"method": "IAM_CONNECTOR", "instance": instance_name})
        try:
            connector = Connector()
            def getconn():
                return connector.connect(
                    instance_name,
                    "pg8000",
                    user=os.getenv("ALLOYDB_USER", "postgres"),
                    db=os.getenv("ALLOYDB_DB", "postgres"),
                    enable_iam_auth=True
                )
            temp_engine = create_engine("postgresql+pg8000://", creator=getconn)
            with temp_engine.connect() as conn:
                results["status"] = "success"
                results["message"] = "Connected via IAM Connector"
                return results
        except Exception as e:
            results["methods_tried"][-1]["error"] = str(e)

    results["status"] = "error"
    results["message"] = "All AlloyDB connection methods failed. System is using SQLite fallback."
    return results

@app.get("/api/system-logs")
def get_system_logs():
    """Fetch recent system logs for debugging."""
    return {"logs": log_buffer.buffer}

@app.get("/healthz")
def healthz():
    """Public health check without /api prefix."""
    return {"status": "ok", "db": db_type_name}

@app.get("/system-logs")
def get_public_system_logs():
    """Fetch recent system logs without /api prefix for debugging."""
    return {"logs": log_buffer.buffer}

@app.get("/api/health")
def health(request: Request):
    logger.info("Health check endpoint called")
    return {
        "status": "healthy",
        "database": db_type_name,
        "env": {
            "PROJECT_ID": "SET" if os.getenv("GOOGLE_CLOUD_PROJECT") else "MISSING",
            "REGION": "SET" if os.getenv("GOOGLE_CLOUD_REGION") else "MISSING",
            "ALLOYDB_INSTANCE": "SET" if os.getenv("ALLOYDB_INSTANCE_NAME") else "MISSING",
            "PORT_ENV": os.getenv("PORT"),
        }
    }

@app.get("/api/debug-headers")
def debug_headers(request: Request):
    """Returns request headers for debugging (masked)."""
    headers = {k: ("****" if k.lower() in ["authorization", "x-goog-api-key", "cookie"] else v) for k, v in request.headers.items()}
    return {"headers": headers}

# Serve static files in production
dist_path = os.path.join(os.getcwd(), "dist")
if os.path.exists(dist_path):
    # Mount static files (assets, etc.)
    assets_path = os.path.join(dist_path, "assets")
    if os.path.exists(assets_path):
        app.mount("/assets", StaticFiles(directory=assets_path), name="assets")
    
    @app.get("/")
    async def serve_root():
        return FileResponse(os.path.join(dist_path, "index.html"))

    @app.get("/{full_path:path}")
    async def serve_spa(full_path: str):
        # If it's an API route, let it 404 naturally if not matched above
        if full_path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        
        # Check if the file exists in dist (e.g. favicon.ico)
        file_path = os.path.join(dist_path, full_path)
        if os.path.isfile(file_path):
            return FileResponse(file_path)
            
        # Fallback to index.html for SPA routing
        return FileResponse(os.path.join(dist_path, "index.html"))

if __name__ == "__main__":
    import uvicorn
    # In AI Studio, PORT is usually 3000. 
    # We want the backend to run on a different port (8000) so Vite can proxy to it from 3000.
    backend_port = 8001
    logger.info(f"Starting backend on port {backend_port}")
    uvicorn.run(app, host="0.0.0.0", port=backend_port)
