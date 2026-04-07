import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createServer as createViteServer } from "vite";
import pg from "pg";
import sqlite3 from "sqlite3";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000; // Vite will run on 3000, but we'll use this for the unified server

app.use(cors());
app.use(express.json());

// --- Database Setup ---
let dbType = "Unknown";
let query: (text: string, params?: any[]) => Promise<any>;

const initDb = async () => {
  const dbUrl = process.env.DATABASE_URL;

  if (dbUrl) {
    try {
      const pool = new pg.Pool({
        connectionString: dbUrl,
        ssl: dbUrl.includes("sslmode=require") ? { rejectUnauthorized: false } : false,
      });
      await pool.query("SELECT NOW()");
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
    await query(`
      CREATE TABLE IF NOT EXISTS action_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        patient_id INTEGER,
        agent_action TEXT,
        tool_used TEXT,
        result TEXT
      )
    `);
    
    // Seed if empty
    const countRes = await query("SELECT COUNT(*) FROM action_logs");
    const count = parseInt(countRes.rows ? countRes.rows[0].count : countRes[0].count);
    if (count === 0) {
      await query(
        "INSERT INTO action_logs (patient_id, agent_action, tool_used, result) VALUES ($1, $2, $3, $4)",
        [0, "INITIALIZATION", "NONE", "VitalFlow Care Orchestrator Node Online. All MCP bridges verified."]
      );
    }
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

app.get("/api/health", (req, res) => {
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
    const result = await query("SELECT * FROM action_logs ORDER BY timestamp DESC LIMIT 10");
    res.json(result.rows.map((row: any) => ({
      id: row.id,
      patient_id: String(row.patient_id),
      action: row.agent_action,
      status: row.tool_used,
      details: row.result,
      created_at: row.timestamp
    })));
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch logs" });
  }
});

// MCP Tools
app.get("/api/tools/calendar", (req, res) => {
  res.json({ availability: ["2026-04-02T09:00:00Z", "2026-04-02T14:00:00Z"] });
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
  const history: any = {
    "100": { surgery: "Appendectomy", date: "2026-03-25", complications: "None" },
    "101": { surgery: "Knee Replacement", date: "2026-03-20", complications: "Mild swelling" },
    "102": { surgery: "Gallbladder Removal", date: "2026-03-28", complications: "None" },
  };
  res.json(history[req.params.patient_id] || { surgery: "Unknown", date: "Unknown", complications: "Unknown" });
});

app.get("/api/tools/action-logs/:patient_id", async (req, res) => {
  try {
    const pid = parseInt(req.params.patient_id);
    const result = await query(
      "SELECT * FROM action_logs WHERE patient_id = $1 ORDER BY timestamp DESC LIMIT 5",
      [pid]
    );
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

app.post("/api/tools/log-task", async (req, res) => {
  const { patient_id, task, status, details } = req.body;
  try {
    const pid = parseInt(patient_id) || 0;
    await query(
      "INSERT INTO action_logs (patient_id, agent_action, tool_used, result) VALUES ($1, $2, $3, $4)",
      [pid, task, status, details]
    );
    res.json({ success: true, logged: `${task} for ${patient_id}` });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to log task" });
  }
});

// --- Vite Integration ---

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
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
