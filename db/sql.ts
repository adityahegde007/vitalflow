export const SQL = {
  logs: {
    selectRecent: "SELECT * FROM action_logs ORDER BY timestamp DESC LIMIT $1",
    selectByPatient: "SELECT * FROM action_logs WHERE patient_id = $1 ORDER BY timestamp DESC LIMIT 5",
    selectByPatientWithLimit:
      "SELECT timestamp, agent_action, tool_used, result FROM action_logs WHERE patient_id = $1 ORDER BY timestamp DESC LIMIT $2",
    selectByPatientForRecall:
      "SELECT timestamp, agent_action, tool_used, result FROM action_logs WHERE patient_id = $1 ORDER BY timestamp DESC LIMIT 5",
    insert:
      "INSERT INTO action_logs (patient_id, agent_action, tool_used, result) VALUES ($1, $2, $3, $4)",
    count: "SELECT COUNT(*) FROM action_logs",
  },
  calendar: {
    markPastUnavailable:
      "UPDATE calendar_slots SET is_available = $1 WHERE is_available = $2 AND slot_time < $3",
    selectAll: "SELECT slot_time, is_available FROM calendar_slots ORDER BY slot_time ASC",
    selectAvailable:
      "SELECT slot_time, is_available FROM calendar_slots WHERE is_available = $1 ORDER BY slot_time ASC",
    selectSlotIds: "SELECT slot_id FROM calendar_slots",
    insertWithSlotId: "INSERT INTO calendar_slots (slot_id, slot_time, is_available) VALUES ($1, $2, $3)",
    insertSimple: "INSERT INTO calendar_slots (slot_time, is_available) VALUES ($1, $2)",
    markBooked: "UPDATE calendar_slots SET is_available = $1 WHERE slot_time = $2",
    count: "SELECT COUNT(*) FROM calendar_slots",
    createTable: `
      CREATE TABLE IF NOT EXISTS calendar_slots (
        slot_time TEXT PRIMARY KEY,
        is_available INTEGER DEFAULT 1
      )
    `,
    pgInfoColumns: "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1",
    sqliteTableInfo: "PRAGMA table_info(calendar_slots)",
    renameSlotToSlotTime: 'ALTER TABLE calendar_slots RENAME COLUMN "slot" TO slot_time',
    addSlotTime: "ALTER TABLE calendar_slots ADD COLUMN slot_time TEXT",
    addIsAvailable: "ALTER TABLE calendar_slots ADD COLUMN is_available INTEGER DEFAULT 1",
  },
  history: {
    selectByPatient:
      "SELECT patient_id, surgery, surgery_date, complications FROM patient_history WHERE patient_id = $1 LIMIT 1",
    upsert: `
      INSERT INTO patient_history (patient_id, surgery, surgery_date, complications, updated_at)
      VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
      ON CONFLICT(patient_id)
      DO UPDATE SET surgery = excluded.surgery, surgery_date = excluded.surgery_date, complications = excluded.complications, updated_at = CURRENT_TIMESTAMP
    `,
    insertSeed:
      "INSERT INTO patient_history (patient_id, surgery, surgery_date, complications) VALUES ($1, $2, $3, $4)",
    count: "SELECT COUNT(*) FROM patient_history",
    createTable: `
      CREATE TABLE IF NOT EXISTS patient_history (
        patient_id INTEGER PRIMARY KEY,
        surgery TEXT,
        surgery_date TEXT,
        complications TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `,
  },
  schema: {
    createActionLogsTable: `
      CREATE TABLE IF NOT EXISTS action_logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        patient_id INTEGER,
        agent_action TEXT,
        tool_used TEXT,
        result TEXT
      )
    `,
  },
  misc: {
    pgNow: "SELECT NOW()",
  },
} as const;

