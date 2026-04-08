# VitalFlow Architecture Document

## 1. Purpose

VitalFlow is an API-first **Multi-Agent Productivity Assistant** for post-surgery recovery operations.  
It coordinates clinical reasoning and logistics execution, persists structured operational data, and exposes realtime workflow progress to the UI.

This document maps the implementation to core product requirements:

1. Primary agent coordinating sub-agents  
2. Structured database storage/retrieval  
3. Multi-tool integration via MCP-compatible interfaces  
4. Multi-step workflow execution  
5. API-based deployable system

## 2. System Overview

```mermaid
flowchart LR
  U[User / Operator] --> UI[React UI]
  UI --> API[Express API: server.ts]

  API --> ORCH[Primary Orchestrator]
  ORCH --> CA[Clinical Analyst Agent]
  ORCH --> LO[Logistics Officer Agent]

  CA --> TOOLS[Tool Layer]
  LO --> TOOLS

  TOOLS --> DB[(PostgreSQL / SQLite)]
  TOOLS --> KB[Recovery Protocol Notes]

  API --> SSE1[/SSE: /api/stream/runs/:runId/]
  API --> SSE2[/SSE: /api/stream/logs/]
  SSE1 --> UI
  SSE2 --> UI
```

## 2.1 AI Usage Highlights

VitalFlow uses AI as the core execution engine, not just a chat layer:

- **Primary AI agent** performs intent understanding and coordination (`ORCHESTRATOR`).
- **Specialized AI sub-agents** execute domain reasoning:
  - `CLINICAL_ANALYST` for symptom/history/protocol analysis
  - `LOGISTICS_OFFICER` for scheduling decisions and booking actions
- **Gemini function-calling loops** are used to invoke tools deterministically during reasoning.
- **AI decisions are persisted and observable** through audit logs and SSE run events.

```mermaid
flowchart TD
  IN[User Message] --> ORCH_AI[Gemini: Primary Orchestrator]
  ORCH_AI -->|delegate_to_clinical_analyst| CLIN_AI[Gemini: Clinical Analyst]
  ORCH_AI -->|delegate_to_logistics_officer| LOG_AI[Gemini: Logistics Officer]

  CLIN_AI --> FC1[Function Calling]
  LOG_AI --> FC2[Function Calling]

  FC1 --> T1[get_patient_history / get_action_logs / get_recovery_protocol]
  FC2 --> T2[check_calendar / book_followup_appointment]

  T1 --> DB[(PostgreSQL/SQLite + Protocol File)]
  T2 --> DB
  DB --> ORCH_AI
  ORCH_AI --> OUT[Final Patient Response + Run Events]
```

## 3. Core Components

### 3.1 API and Runtime

- Entry point: `server.ts`
- Responsibilities:
  - HTTP APIs for orchestration and tools
  - SSE streams for realtime run/log updates
  - DB initialization and query execution
  - CORS, rate limiting, input-size and basic safety headers

### 3.2 Primary + Sub-Agent Orchestration

- Primary orchestration module: `server/agents/orchestrator.ts`
- Agent roles:
  - `ORCHESTRATOR`: route, delegate, and finalize response
  - `CLINICAL_ANALYST`: history/protocol/symptom workflows
  - `LOGISTICS_OFFICER`: calendar availability and booking

### 3.3 Tool Integration (MCP-Compatible)

- Registry: `server/mcpRegistry.ts`
- Endpoints:
  - `GET /api/mcp/tools/list`
  - `POST /api/mcp/tools/call`
- Direct tool APIs:
  - calendar (`/api/tools/calendar`, `/api/tools/calendar/book`)
  - history (`/api/tools/patient-history/*`)
  - logs (`/api/tools/action-logs/*`, `/api/tools/log-task`)
  - protocol (`/api/tools/protocol`)

### 3.4 Data Layer

- SQL module: `db/sql.ts`
- Core tables:
  - `patient_history`
  - `calendar_slots`
  - `action_logs`
- DB mode:
  - PostgreSQL (primary)
  - SQLite (portable fallback)

## 4. End-to-End Orchestration Flow

```mermaid
sequenceDiagram
  autonumber
  participant UI as React UI
  participant API as Express API
  participant OR as Primary Orchestrator
  participant CA as Clinical Analyst
  participant LO as Logistics Officer
  participant DB as PostgreSQL/SQLite

  UI->>API: POST /api/orchestrate {message, patient_id?}
  API-->>UI: {success, run_id}
  UI->>API: GET /api/stream/runs/:runId (SSE)

  API->>OR: executeMultiAgentOrchestration(...)
  OR->>DB: fetch patient history
  OR->>CA: delegate clinical reasoning
  CA->>DB: get/update history + read logs
  CA-->>OR: clinical result

  OR->>LO: delegate scheduling if needed
  LO->>DB: check slots / mark booked / write logs
  LO-->>OR: logistics result

  OR->>DB: write final orchestration log
  API-->>UI: SSE run_event updates (all steps)
  API-->>UI: SSE logs/calendar refresh
```

## 5. Data Model

```mermaid
erDiagram
  PATIENT_HISTORY {
    int patient_id PK
    text surgery
    text surgery_date
    text complications
    timestamp updated_at
  }

  CALENDAR_SLOTS {
    text slot_time PK
    int is_available
  }

  ACTION_LOGS {
    int id PK
    timestamp timestamp
    int patient_id
    text agent_action
    text tool_used
    text result
  }

  PATIENT_HISTORY ||--o{ ACTION_LOGS : "patient_id"
```

## 6. API Surface (Key)

- System:
  - `POST /api/orchestrate`
  - `GET /api/stream/runs/:runId`
  - `GET /api/health`
- Observability:
  - `GET /api/logs`
  - `GET /api/stream/logs`
- MCP-compatible bridge:
  - `GET /api/mcp/tools/list`
  - `POST /api/mcp/tools/call`
- OpenAPI + docs:
  - `GET /openapi.json`
  - `GET /docs`

## 7. Deployment Architecture

```mermaid
flowchart TB
  Dev[Source Repo] --> Build[Docker Build]
  Build --> Image[Container Image]
  Image --> CloudRun[Google Cloud Run Service]

  CloudRun --> Web[Web UI]
  CloudRun --> Api[API Endpoints]

  CloudRun --> PG[(PostgreSQL / AlloyDB)]
  CloudRun --> Lite[(SQLite mode for local/demo)]
```

## 8. Realtime Observability Model

- Run-level telemetry:
  - buffered run events in memory
  - streamed via `/api/stream/runs/:runId`
- Global operational telemetry:
  - recent action logs
  - calendar updates
  - streamed via `/api/stream/logs`
- UI behavior:
  - active agent state updates during run
  - audit trail and calendar refresh without manual reload

## 9. Security and Abuse Controls

- CORS allowlist support (`CORS_ORIGINS`, `CORS_ALLOW_ALL`)
- Rate limits for general and write APIs
- Input validation for IDs and text fields
- JSON body limit (`JSON_LIMIT`)
- Safe response headers (`X-Content-Type-Options`, `X-Frame-Options`, etc.)

## 10. Requirements Traceability

### Goal 1: Primary agent coordinates sub-agents
- Implemented by `executeMultiAgentOrchestration` in `server/agents/orchestrator.ts`
- Delegation tools:
  - `delegate_to_clinical_analyst`
  - `delegate_to_logistics_officer`
- AI execution path uses Gemini model-driven delegation and synthesis.

### Goal 2: Structured DB storage/retrieval
- Implemented using SQL queries in `db/sql.ts`
- Persistent entities: history, slots, action logs

### Goal 3: Multi-tool integration via MCP
- Implemented via MCP-compatible registry and call APIs
- Typed schemas in `server/mcpRegistry.ts`

### Goal 4: Multi-step workflows and execution
- End-to-end run orchestration with conditional delegation and DB updates
- Observable with run-event SSE streams
- AI reasoning + function calling are interleaved across steps until completion.

### Goal 5: API-based deployment
- OpenAPI contract (`openapi.json`) and Swagger UI (`/docs`)
- Dockerized runtime deployable to Cloud Run

## 11. Repository Mapping

- `server.ts`: API host, SSE, middleware, DB bootstrap
- `server/agents/orchestrator.ts`: primary/sub-agent orchestration logic
- `server/mcpRegistry.ts`: MCP-compatible tool schemas
- `db/sql.ts`: centralized SQL statements
- `src/App.tsx`: realtime UI orchestration client
- `openapi.json`: API contract
