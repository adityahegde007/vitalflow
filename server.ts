import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import pg from "pg";
import sqlite3 from "sqlite3";
import fs from "fs";
import dotenv from "dotenv";
import { type NextFunction, type Request, type Response } from "express";
import { SQL } from "./db/sql";
import { executeMultiAgentOrchestration } from "./server/agents/orchestrator.ts";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10); // Vite will run on 3000, but we'll use this for the unified server
const JSON_LIMIT = process.env.JSON_LIMIT || "1Mb";
const CORS_ALLOW_ALL = process.env.CORS_ALLOW_ALL === "true";
const HEALTH_VERBOSE = process.env.HEALTH_VERBOSE === "true";
const USE_VITE_DEV_SERVER = process.env.USE_VITE_DEV_SERVER === "true";
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
});
app.use(
  cors({
    origin: (origin, callback) => {
      if (CORS_ALLOW_ALL) {
        callback(null, true);
        return;
      }
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.includes(origin));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: JSON_LIMIT }));

type RateLimitBucket = {
  windowStart: number;
  count: number;
};

const rateLimitStore = new Map<string, RateLimitBucket>();

function getRateLimitWindowMs() {
  return parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
}

function getGeneralRateLimitMax() {
  return parseInt(process.env.RATE_LIMIT_MAX || "120", 10);
}

function getWriteRateLimitMax() {
  return parseInt(process.env.RATE_LIMIT_WRITE_MAX || "40", 10);
}

function getClientKey(req: Request) {
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0].trim()
      : req.ip || "unknown-ip";
  return `${ip}`;
}

function createRateLimiter(maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const windowMs = getRateLimitWindowMs();
    const key = `${getClientKey(req)}:${maxRequests}`;
    const bucket = rateLimitStore.get(key);

    if (!bucket || now - bucket.windowStart >= windowMs) {
      rateLimitStore.set(key, { windowStart: now, count: 1 });
      next();
      return;
    }

    if (bucket.count >= maxRequests) {
      const retryAfterSeconds = Math.ceil((windowMs - (now - bucket.windowStart)) / 1000);
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({
        error: "Too many requests. Please slow down and retry shortly.",
        retry_after_seconds: retryAfterSeconds
      });
      return;
    }

    bucket.count += 1;
    rateLimitStore.set(key, bucket);
    next();
  };
}

const generalRateLimiter = createRateLimiter(getGeneralRateLimitMax());
const writeRateLimiter = createRateLimiter(getWriteRateLimitMax());

app.use("/api", generalRateLimiter);

setInterval(() => {
  const now = Date.now();
  const windowMs = getRateLimitWindowMs();
  for (const [key, bucket] of rateLimitStore.entries()) {
    if (now - bucket.windowStart >= windowMs) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// --- Database Setup ---
let dbType = "Unknown";
let query: (text: string, params?: any[]) => Promise<any>;
const logSubscribers = new Set<Response>();
const runSubscribers = new Map<string, Set<Response>>();
const runEventBuffer = new Map<string, any[]>();

interface ActionLogRow {
  id: number;
  patient_id: number | string;
  agent_action: string;
  tool_used: string;
  result: string;
  timestamp: string;
}

interface CalendarSlotRow {
  slot_time: string;
  is_available: number | string;
}

type AgentName = "ORCHESTRATOR" | "CLINICAL_ANALYST" | "LOGISTICS_OFFICER";

import { mcpToolRegistry } from "./server/mcpRegistry.ts";

const calendarSchema = {
  hasSlotId: false,
  slotIdIsNumeric: false,
};

function isValidPatientId(raw: unknown): boolean {
  const parsed = parseInt(String(raw), 10);
  return !Number.isNaN(parsed) && parsed >= 1 && parsed <= 999999;
}

function isSafeShortText(raw: unknown, maxLen = 500): boolean {
  return typeof raw === "string" && raw.length > 0 && raw.length <= maxLen;
}

function normalizeDatabaseUrlForPg(rawUrl: string): { normalizedUrl: string; useInsecureTlsFallback: boolean } {
  try {
    const parsed = new URL(rawUrl);
    const sslmode = parsed.searchParams.get("sslmode");
    const useLibpqCompat = parsed.searchParams.get("uselibpqcompat") === "true";

    if (sslmode && ["prefer", "require", "verify-ca"].includes(sslmode) && !useLibpqCompat) {
      // Default to the current stronger behavior and avoid pg warning noise.
      parsed.searchParams.set("sslmode", "verify-full");
      return { normalizedUrl: parsed.toString(), useInsecureTlsFallback: false };
    }

    return {
      normalizedUrl: parsed.toString(),
      // Explicitly opt into libpq-compatible "require" behavior when requested.
      useInsecureTlsFallback: sslmode === "require" && useLibpqCompat,
    };
  } catch {
    // Keep original URL if parsing fails; pg will surface a descriptive error.
    return { normalizedUrl: rawUrl, useInsecureTlsFallback: false };
  }
}

const mapActionLog = (row: ActionLogRow) => ({
  id: row.id,
  patient_id: String(row.patient_id),
  action: row.agent_action,
  status: row.tool_used,
  details: row.result,
  created_at: row.timestamp
});

async function getRecentLogs(limit = 10) {
  const result = await query(SQL.logs.selectRecent, [limit]);
  return (result.rows as ActionLogRow[]).map(mapActionLog);
}

function generateUpcomingDefaultSlots() {
  const now = new Date();
  const day1Nine = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  day1Nine.setUTCHours(9, 0, 0, 0);
  const day1Two = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  day1Two.setUTCHours(14, 0, 0, 0);
  return [day1Nine.toISOString(), day1Two.toISOString()];
}

async function ensureUpcomingCalendarSlots() {
  await query(
    SQL.calendar.markPastUnavailable,
    [0, 1, new Date().toISOString()]
  );

  const result = await query(SQL.calendar.selectAll);
  const rows = result.rows as CalendarSlotRow[];
  const now = new Date();
  const futureAvailable = rows.filter((row) => Number(row.is_available) === 1 && new Date(row.slot_time) > now);

  if (futureAvailable.length >= 2) return;

  const existing = new Set(rows.map((row) => row.slot_time));
  let dayOffset = 1;
  let guard = 0;
  while (futureAvailable.length < 2 && guard < 30) {
    const date = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const nine = new Date(date);
    nine.setUTCHours(9, 0, 0, 0);
    const two = new Date(date);
    two.setUTCHours(14, 0, 0, 0);
    for (const slot of [nine.toISOString(), two.toISOString()]) {
      if (!existing.has(slot)) {
        await insertCalendarSlot(slot, 1);
        existing.add(slot);
        futureAvailable.push({ slot_time: slot, is_available: 1 });
        if (futureAvailable.length >= 2) break;
      }
    }
    dayOffset += 1;
    guard += 1;
  }
}

async function getAvailableCalendarSlots(limit = 20) {
  await ensureUpcomingCalendarSlots();
  const result = await query(
    SQL.calendar.selectAvailable,
    [1]
  );
  const now = new Date();
  return (result.rows as CalendarSlotRow[])
    .map((row) => row.slot_time)
    .filter((slot) => new Date(slot) > now)
    .slice(0, limit);
}

async function insertCalendarSlot(slotTime: string, isAvailable = 1) {
  if (calendarSchema.hasSlotId) {
    const slotIdRes = await query(SQL.calendar.selectSlotIds);
    let maxNumericId = 0;
    for (const row of slotIdRes.rows || []) {
      const parsed = parseInt(String(row.slot_id), 10);
      if (!Number.isNaN(parsed) && parsed > maxNumericId) {
        maxNumericId = parsed;
      }
    }
    const nextNumeric = maxNumericId + 1;
    const nextSlotId: string | number = calendarSchema.slotIdIsNumeric ? nextNumeric : String(nextNumeric);
    await query(
      SQL.calendar.insertWithSlotId,
      [nextSlotId, slotTime, isAvailable]
    );
    return;
  }
  await query(SQL.calendar.insertSimple, [slotTime, isAvailable]);
}

async function normalizeCalendarTableSchema() {
  try {
    if (dbType.startsWith("PostgreSQL")) {
      const columnsRes = await query(
        SQL.calendar.pgInfoColumns,
        ["calendar_slots"]
      );
      const columns = new Set((columnsRes.rows || []).map((row: any) => String(row.column_name)));
      calendarSchema.hasSlotId = columns.has("slot_id");
      const slotIdColumn = (columnsRes.rows || []).find((row: any) => String(row.column_name) === "slot_id");
      const slotIdType = String(slotIdColumn?.data_type || "").toLowerCase();
      calendarSchema.slotIdIsNumeric = ["integer", "bigint", "smallint", "numeric", "real", "double precision", "decimal"].includes(slotIdType);

      if (!columns.has("slot_time") && columns.has("slot")) {
        await query(SQL.calendar.renameSlotToSlotTime);
      } else if (!columns.has("slot_time")) {
        await query(SQL.calendar.addSlotTime);
      }

      if (!columns.has("is_available")) {
        await query(SQL.calendar.addIsAvailable);
      }
      return;
    }

    if (dbType.startsWith("SQLite")) {
      const columnsRes = await query(SQL.calendar.sqliteTableInfo);
      const columns = new Set((columnsRes.rows || []).map((row: any) => String(row.name)));
      calendarSchema.hasSlotId = columns.has("slot_id");
      const slotIdColumn = (columnsRes.rows || []).find((row: any) => String(row.name) === "slot_id");
      const slotIdType = String(slotIdColumn?.type || "").toLowerCase();
      calendarSchema.slotIdIsNumeric = slotIdType.includes("int") || slotIdType.includes("numeric") || slotIdType.includes("real") || slotIdType.includes("double") || slotIdType.includes("decimal");

      if (!columns.has("slot_time") && columns.has("slot")) {
        await query(SQL.calendar.renameSlotToSlotTime);
      } else if (!columns.has("slot_time")) {
        await query(SQL.calendar.addSlotTime);
      }

      if (!columns.has("is_available")) {
        await query(SQL.calendar.addIsAvailable);
      }
    }
  } catch (err) {
    console.error("Calendar schema normalization failed:", err);
    throw err;
  }
}

async function broadcastLogs() {
  if (logSubscribers.size === 0) return;
  try {
    const logs = await getRecentLogs(10);
    const payload = `event: logs\ndata: ${JSON.stringify(logs)}\n\n`;
    for (const res of logSubscribers) {
      res.write(payload);
    }
  } catch (err) {
    console.error("Failed to broadcast logs:", err);
  }
}

async function broadcastCalendar() {
  if (logSubscribers.size === 0) return;
  try {
    const availability = await getAvailableCalendarSlots(20);
    const payload = `event: calendar\ndata: ${JSON.stringify({ availability })}\n\n`;
    for (const res of logSubscribers) {
      res.write(payload);
    }
  } catch (err) {
    console.error("Failed to broadcast calendar:", err);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function runPayload(runId: string, event: Record<string, unknown>) {
  return {
    run_id: runId,
    timestamp: nowIso(),
    ...event,
  };
}

function pushRunEvent(runId: string, event: Record<string, unknown>) {
  const payload = runPayload(runId, event);
  const history = runEventBuffer.get(runId) || [];
  history.push(payload);
  if (history.length > 200) history.shift();
  runEventBuffer.set(runId, history);

  const subs = runSubscribers.get(runId);
  if (!subs || subs.size === 0) return;
  const line = `event: run_event\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of subs) {
    res.write(line);
  }
}

function completeRunLater(runId: string) {
  setTimeout(() => {
    runEventBuffer.delete(runId);
    runSubscribers.delete(runId);
  }, 5 * 60 * 1000);
}

function extractPatientIdFromText(text: string) {
  const explicit = text.match(/patient(?:\s*id)?\s*[:#-]?\s*(\d{1,6})/i);
  if (explicit) return parseInt(explicit[1], 10);
  const fallback = text.match(/\b(\d{1,6})\b/);
  return fallback ? parseInt(fallback[1], 10) : null;
}

const initDb = async () => {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    try {
      const { normalizedUrl, useInsecureTlsFallback } = normalizeDatabaseUrlForPg(dbUrl);
      const pool = new pg.Pool({
        connectionString: normalizedUrl,
        ...(useInsecureTlsFallback ? { ssl: { rejectUnauthorized: false } } : {}),
      });
      await pool.query(SQL.misc.pgNow);
      dbType = "PostgreSQL (AlloyDB)";
      query = (text, params) => pool.query(text, params);
      console.log("Connected to PostgreSQL");
    } catch (err) {
      console.error("PostgreSQL connection failed, falling back to SQLite:", err);
      setupSQLite();
    }
  } else {
    setupSQLite();
  }

  // Create table if not exists
  try {
    await query(SQL.schema.createActionLogsTable);
    await query(SQL.history.createTable);
    await query(SQL.calendar.createTable);
    await normalizeCalendarTableSchema();

    // Seed if empty
    const countRes = await query(SQL.logs.count);
    const count = parseInt(countRes.rows ? countRes.rows[0].count : countRes[0].count);
    if (count === 0) {
      await query(SQL.logs.insert, [
        0,
        "INITIALIZATION",
        "NONE",
        "VitalFlow Care Orchestrator Node Online. All MCP bridges verified.",
      ]);
    }

    const historyCountRes = await query(SQL.history.count);
    const historyCount = parseInt(historyCountRes.rows[0].count);
    if (historyCount === 0) {
      await query(SQL.history.insertSeed, [100, "Appendectomy", "2026-03-25", "None"]);
      await query(SQL.history.insertSeed, [101, "Knee Replacement", "2026-03-20", "Mild swelling"]);
      await query(SQL.history.insertSeed, [102, "Gallbladder Removal", "2026-03-28", "None"]);
    }

    const slotCountRes = await query(SQL.calendar.count);
    const slotCount = parseInt(slotCountRes.rows[0].count);
    if (slotCount === 0) {
      for (const slot of generateUpcomingDefaultSlots()) {
        await insertCalendarSlot(slot, 1);
      }
    }
    await ensureUpcomingCalendarSlots();
  } catch (err) {
    console.error("Table creation/seeding failed:", err);
  }
};

function setupSQLite() {
  const sqliteDb = new sqlite3.Database("./vitalflow.db");
  dbType = "SQLite (Fallback)";
  query = (text, params = []) => {
    // Convert $1, $2 to ? for sqlite
    const sqliteQuery = text.replace(/\$(\d+)/g, "?");
    return new Promise((resolve, reject) => {
      if (text.trim().toUpperCase().startsWith("SELECT")) {
        sqliteDb.all(sqliteQuery, params, (err, rows) => {
          if (err) reject(err);
          else resolve({ rows });
        });
      } else {
        sqliteDb.run(sqliteQuery, params, function (err) {
          if (err) reject(err);
          else resolve({ rows: [], lastID: this.lastID });
        });
      }
    });
  };
  console.log("Using SQLite fallback");
}

initDb();

// --- API Routes ---

app.get("/openapi.json", (req, res) => {
  res.sendFile(path.join(__dirname, "openapi.json"));
});

app.get("/docs", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>VitalFlow API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f8fafc; }
      #swagger-ui { max-width: 1200px; margin: 0 auto; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: "/openapi.json",
        dom_id: "#swagger-ui",
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis],
      });
    </script>
  </body>
</html>`);
});

app.get("/api/health", (req, res) => {
  if (!HEALTH_VERBOSE) {
    res.json({ status: "healthy" });
    return;
  }
  res.json({
    status: "healthy",
    database: dbType,
    env: {
      DATABASE_URL: process.env.DATABASE_URL ? "SET" : "MISSING",
      PORT: process.env.PORT || 3000,
    }
  });
});

app.get("/api/logs", async (req, res) => {
  try {
    res.json(await getRecentLogs(10));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

app.get("/api/stream/logs", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  logSubscribers.add(res);
  try {
    const logs = await getRecentLogs(10);
    res.write(`event: logs\ndata: ${JSON.stringify(logs)}\n\n`);
    const availability = await getAvailableCalendarSlots(20);
    res.write(`event: calendar\ndata: ${JSON.stringify({ availability })}\n\n`);
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Unable to load logs." })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 25000);

  req.on("close", () => {
    clearInterval(heartbeat);
    logSubscribers.delete(res);
  });
});

app.get("/api/stream/runs/:runId", (req, res) => {
  const runId = req.params.runId;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const subs = runSubscribers.get(runId) || new Set<Response>();
  subs.add(res);
  runSubscribers.set(runId, subs);

  const history = runEventBuffer.get(runId) || [];
  for (const event of history) {
    res.write(`event: run_event\ndata: ${JSON.stringify(event)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const setForRun = runSubscribers.get(runId);
    if (!setForRun) return;
    setForRun.delete(res);
    if (setForRun.size === 0) runSubscribers.delete(runId);
  });
});

app.get("/api/mcp/tools/list", (req, res) => {
  res.json({
    protocol: "mcp-compat-rest-v1",
    tools: mcpToolRegistry
  });
});

app.post("/api/mcp/tools/call", writeRateLimiter, async (req, res) => {
  const callId = isSafeShortText(req.body?.call_id, 128) ? req.body.call_id : `call_${Date.now()}`;
  const toolName = req.body?.tool_name;
  const args = req.body?.arguments || {};

  const envelope = {
    call_id: callId,
    tool_name: String(toolName || ""),
    timestamp: nowIso()
  };

  try {
    if (!toolName || typeof toolName !== "string") {
      res.status(400).json({ ...envelope, success: false, error: "tool_name is required" });
      return;
    }

    if (toolName === "check_calendar") {
      const availability = await getAvailableCalendarSlots(20);
      res.json({ ...envelope, success: true, result: { availability } });
      return;
    }

    if (toolName === "book_followup_appointment") {
      const pid = parseInt(String(args.patient_id), 10);
      if (!isValidPatientId(pid)) {
        res.status(400).json({ ...envelope, success: false, error: "Invalid patient_id" });
        return;
      }
      const availability = await getAvailableCalendarSlots(20);
      const preferred = typeof args.preferred_slot === "string" ? args.preferred_slot : undefined;
      const slotToBook = preferred && availability.includes(preferred) ? preferred : availability[0];
      if (!slotToBook) {
        res.status(409).json({ ...envelope, success: false, error: "No available slots" });
        return;
      }
      await query(SQL.calendar.markBooked, [0, slotToBook]);
      await ensureUpcomingCalendarSlots();
      const refreshed = await getAvailableCalendarSlots(20);
      await query(SQL.logs.insert, [pid, "FOLLOW_UP_BOOKED", "MCP_CALENDAR", `Appointment slot reserved: ${slotToBook}`]);
      await broadcastCalendar();
      await broadcastLogs();
      res.json({ ...envelope, success: true, result: { booked_slot: slotToBook, availability: refreshed } });
      return;
    }

    if (toolName === "get_recovery_protocol") {
      const protocol = fs.readFileSync(path.join(__dirname, "recovery_protocols.md"), "utf8");
      res.json({ ...envelope, success: true, result: { protocol } });
      return;
    }

    if (toolName === "get_patient_history") {
      const pid = parseInt(String(args.patient_id), 10);
      if (!isValidPatientId(pid)) {
        res.status(400).json({ ...envelope, success: false, error: "Invalid patient_id" });
        return;
      }
      const result = await query(SQL.history.selectByPatient, [pid]);
      const row = result.rows[0];
      res.json({
        ...envelope,
        success: true,
        result: row
          ? {
              patient_id: String(row.patient_id),
              surgery: row.surgery,
              date: row.surgery_date,
              complications: row.complications
            }
          : { patient_id: String(pid), surgery: "Unknown", date: "Unknown", complications: "Unknown" }
      });
      return;
    }

    if (toolName === "update_patient_history") {
      const pid = parseInt(String(args.patient_id), 10);
      if (!isValidPatientId(pid)) {
        res.status(400).json({ ...envelope, success: false, error: "Invalid patient_id" });
        return;
      }
      await query(SQL.history.upsert, [
        pid,
        String(args.surgery || "Unknown"),
        String(args.date || "Unknown"),
        String(args.complications || "Unknown"),
      ]);
      res.json({ ...envelope, success: true, result: { patient_id: String(pid) } });
      return;
    }

    if (toolName === "get_action_logs") {
      const pid = parseInt(String(args.patient_id), 10);
      if (!isValidPatientId(pid)) {
        res.status(400).json({ ...envelope, success: false, error: "Invalid patient_id" });
        return;
      }
      const limit = parseInt(String(args.limit || 5), 10) || 5;
      const result = await query(SQL.logs.selectByPatientWithLimit, [pid, limit]);
      res.json({
        ...envelope,
        success: true,
        result: (result.rows || []).map((row: any) => ({
          timestamp: row.timestamp,
          action: row.agent_action,
          status: row.tool_used,
          result: row.result
        }))
      });
      return;
    }

    if (toolName === "update_patient_task") {
      const pid = parseInt(String(args.patient_id), 10);
      if (!isValidPatientId(pid)) {
        res.status(400).json({ ...envelope, success: false, error: "Invalid patient_id" });
        return;
      }
      await query(SQL.logs.insert, [
        pid,
        String(args.task || "UNKNOWN"),
        String(args.status || "LOGGED"),
        String(args.details || ""),
      ]);
      await ensureUpcomingCalendarSlots();
      await broadcastCalendar();
      await broadcastLogs();
      res.json({ ...envelope, success: true, result: { logged: `${args.task} for ${pid}` } });
      return;
    }

    res.status(404).json({ ...envelope, success: false, error: `Unknown tool: ${toolName}` });
  } catch (err: any) {
    res.status(500).json({ ...envelope, success: false, error: err?.message || "Tool call failed" });
  }
});

app.post("/api/orchestrate", writeRateLimiter, async (req, res) => {
  const { message, patient_id } = req.body || {};
  if (!isSafeShortText(message, 3000)) {
    res.status(400).json({ success: false, error: "Invalid message" });
    return;
  }

  const explicitPatientId = parseInt(String(patient_id), 10);
  const inferredPatientId = extractPatientIdFromText(message);
  const pid = !Number.isNaN(explicitPatientId) ? explicitPatientId : inferredPatientId;

  if (!pid || !isValidPatientId(pid)) {
    res.status(400).json({ success: false, error: "Valid patient_id is required." });
    return;
  }

  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  runEventBuffer.set(runId, []);
  pushRunEvent(runId, {
    type: "accepted",
    agent: "ORCHESTRATOR" as AgentName,
    status: "running",
    step: "Run accepted",
    data: { patient_id: String(pid) }
  });

  void executeMultiAgentOrchestration(runId, pid, message, {
    query,
    pushRunEvent,
    broadcastLogs,
    broadcastCalendar,
    ensureUpcomingCalendarSlots,
    getAvailableCalendarSlots
  });
  res.json({ success: true, run_id: runId, patient_id: String(pid) });
});

// MCP Tools
app.get("/api/tools/calendar", (req, res) => {
  (async () => {
    try {
      const availability = await getAvailableCalendarSlots(20);
      res.json({ availability });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch calendar availability" });
    }
  })();
});

app.post("/api/tools/calendar/book", writeRateLimiter, async (req, res) => {
  try {
    const { patient_id, preferred_slot } = req.body || {};
    if (!isValidPatientId(patient_id)) {
      res.status(400).json({ success: false, error: "Invalid patient_id" });
      return;
    }
    if (preferred_slot && !isSafeShortText(preferred_slot, 64)) {
      res.status(400).json({ success: false, error: "Invalid preferred_slot" });
      return;
    }

    const availability = await getAvailableCalendarSlots(20);
    const slotToBook = preferred_slot && availability.includes(preferred_slot) ? preferred_slot : availability[0];

    if (!slotToBook) {
      res.status(409).json({ success: false, error: "No available slots." });
      return;
    }

    await query(SQL.calendar.markBooked, [0, slotToBook]);
    await ensureUpcomingCalendarSlots();
    const refreshedAvailability = await getAvailableCalendarSlots(20);

    const pid = parseInt(String(patient_id || 0), 10) || 0;
    await query(SQL.logs.insert, [pid, "FOLLOW_UP_BOOKED", "CALENDAR", `Appointment slot reserved: ${slotToBook}`]);

    await broadcastCalendar();
    await broadcastLogs();
    res.json({ success: true, booked_slot: slotToBook, availability: refreshedAvailability });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to book calendar slot" });
  }
});

app.get("/api/tools/protocol", (req, res) => {
  try {
    const protocol = fs.readFileSync(path.join(__dirname, "recovery_protocols.md"), "utf8");
    res.json({ protocol });
  } catch (err) {
    res.status(404).json({ error: "Protocol file not found" });
  }
});

app.get("/api/tools/patient-history/:patient_id", (req, res) => {
  (async () => {
    try {
      const pid = parseInt(req.params.patient_id, 10);
      if (Number.isNaN(pid)) {
        res.status(400).json({ error: "Invalid patient_id" });
        return;
      }

      const result = await query(SQL.history.selectByPatient, [pid]);

      if (result.rows.length === 0) {
        res.json({ surgery: "Unknown", date: "Unknown", complications: "Unknown" });
        return;
      }

      const row = result.rows[0];
      res.json({
        patient_id: String(row.patient_id),
        surgery: row.surgery,
        date: row.surgery_date,
        complications: row.complications
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch patient history" });
    }
  })();
});

app.post("/api/tools/patient-history", writeRateLimiter, async (req, res) => {
  try {
    const { patient_id, surgery, date, complications } = req.body;
    if (!isValidPatientId(patient_id)) {
      res.status(400).json({ success: false, error: "Invalid patient_id" });
      return;
    }
    if (!isSafeShortText(surgery, 150) || !isSafeShortText(date, 20) || !isSafeShortText(complications, 500)) {
      res.status(400).json({ success: false, error: "Invalid payload fields" });
      return;
    }
    const pid = parseInt(String(patient_id), 10);

    await query(SQL.history.upsert, [pid, surgery || "Unknown", date || "Unknown", complications || "Unknown"]);

    res.json({ success: true, patient_id: String(pid) });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to upsert patient history" });
  }
});

app.get("/api/tools/action-logs/:patient_id", async (req, res) => {
  try {
    const pid = parseInt(req.params.patient_id);
    const result = await query(SQL.logs.selectByPatient, [pid]);
    res.json(result.rows.map((row: any) => ({
      timestamp: row.timestamp,
      action: row.agent_action,
      status: row.tool_used,
      result: row.result
    })));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch patient logs" });
  }
});

app.post("/api/tools/log-task", writeRateLimiter, async (req, res) => {
  const { patient_id, task, status, details } = req.body;
  try {
    if (!isValidPatientId(patient_id)) {
      res.status(400).json({ success: false, error: "Invalid patient_id" });
      return;
    }
    if (!isSafeShortText(task, 120) || !isSafeShortText(status, 60) || !isSafeShortText(details, 1000)) {
      res.status(400).json({ success: false, error: "Invalid payload fields" });
      return;
    }

    const pid = parseInt(patient_id, 10);
    await query(SQL.logs.insert, [pid, task, status, details]);
    await ensureUpcomingCalendarSlots();
    await broadcastCalendar();
    await broadcastLogs();
    res.json({ success: true, logged: `${task} for ${patient_id}` });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to log task" });
  }
});

// --- Vite Integration ---

async function startServer() {
  if (USE_VITE_DEV_SERVER) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
