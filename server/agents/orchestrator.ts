import { GoogleGenAI, Type } from "@google/genai";
import { SQL } from "../../db/sql";
import fs from "fs";
import path from "path";

export interface SystemDependencies {
  query: (sql: string, params?: any[]) => Promise<any>;
  pushRunEvent: (runId: string, event: any) => void;
  broadcastLogs: () => Promise<void>;
  broadcastCalendar: () => Promise<void>;
  ensureUpcomingCalendarSlots: () => Promise<void>;
  getAvailableCalendarSlots: (limit: number) => Promise<string[]>;
}

export async function executeMultiAgentOrchestration(
  runId: string,
  patientId: number,
  message: string,
  deps: SystemDependencies
) {
  const { query, pushRunEvent, broadcastLogs, broadcastCalendar, ensureUpcomingCalendarSlots, getAvailableCalendarSlots } = deps;

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = "gemini-2.5-flash";

  // --- Sub-Agent: Clinical Analyst ---
  const clinicalTools = [{
    functionDeclarations: [
      {
        name: "get_patient_history",
        description: "Read patient history from DB.",
        parameters: { type: Type.OBJECT, properties: { patient_id: { type: Type.INTEGER } }, required: ["patient_id"] }
      },
      {
        name: "update_patient_history",
        description: "Create/update patient history.",
        parameters: { type: Type.OBJECT, properties: { patient_id: { type: Type.INTEGER }, surgery: { type: Type.STRING }, date: { type: Type.STRING }, complications: { type: Type.STRING } }, required: ["patient_id", "surgery", "date", "complications"] }
      },
      {
        name: "get_action_logs",
        description: "Read patient-specific action logs. Use this to find 'earlier' or past symptoms.",
        parameters: { type: Type.OBJECT, properties: { patient_id: { type: Type.INTEGER } }, required: ["patient_id"] }
      },
      {
        name: "get_recovery_protocol",
        description: "Read the standard post-surgery recovery protocol guidelines.",
        parameters: { type: Type.OBJECT, properties: {} }
      }
    ]
  }];

  async function engageClinicalAnalyst(queryText: string): Promise<string> {
    pushRunEvent(runId, { type: "step", agent: "CLINICAL_ANALYST", status: "running", step: "Clinical Analyst engaged.", data: { query: queryText } });
    
    let chat = ai.chats.create({
      model,
      config: {
        systemInstruction: "You are the VitalFlow Clinical Analyst. You evaluate medical symptoms and protocol deviations. ALWAYS lookup patient history and action logs before answering anything regarding past records or symptoms. You CANNOT book appointments, tell the orchestrator if an appointment is needed.",
        tools: clinicalTools,
        temperature: 0.1
      }
    });

    let currentResponse = await chat.sendMessage({ message: queryText });

    while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
      const call = currentResponse.functionCalls[0];
      const args = call.args as Record<string, any>;
      pushRunEvent(runId, { type: "step", agent: "CLINICAL_ANALYST", status: "running", step: `Executing ${call.name}`, data: args });
      
      let resultObj: any = {};
      try {
        if (call.name === "get_patient_history") {
          const result = await query(SQL.history.selectByPatient, [args.patient_id]);
          resultObj = result.rows[0] ? result.rows[0] : { error: "No history found" };
        } else if (call.name === "update_patient_history") {
          await query(SQL.history.upsert, [args.patient_id, args.surgery, args.date, args.complications]);
          resultObj = { success: true };
          await query(SQL.logs.insert, [args.patient_id, "PATIENT_HISTORY_UPDATED", "CLINICAL_ANALYST", `Updated: ${args.surgery}`]);
          await broadcastLogs();
        } else if (call.name === "get_action_logs") {
          const result = await query(SQL.logs.selectByPatientForRecall, [args.patient_id]);
          resultObj = { logs: result.rows || [] };
        } else if (call.name === "get_recovery_protocol") {
          const protocolStr = fs.readFileSync(path.join(process.cwd(), "recovery_protocols.md"), "utf8");
          resultObj = { protocol: protocolStr };
        }
      } catch (err: any) {
        resultObj = { error: err.message };
      }

      currentResponse = await chat.sendMessage({
        message: [
          { functionResponse: { name: call.name, response: resultObj } }
        ]
      });
    }
    
    pushRunEvent(runId, { type: "step", agent: "CLINICAL_ANALYST", status: "done", step: "Clinical analysis complete." });
    return currentResponse.text || "No clinical insight.";
  }

  // --- Sub-Agent: Logistics Officer ---
  const logisticsTools = [{
    functionDeclarations: [
      {
        name: "check_calendar",
        description: "Get follow-up appointment availability.",
        parameters: { type: Type.OBJECT, properties: {}, additionalProperties: false }
      },
      {
        name: "book_followup_appointment",
        description: "Book the earliest or preferred follow-up slot.",
        parameters: { type: Type.OBJECT, properties: { patient_id: { type: Type.INTEGER }, preferred_slot: { type: Type.STRING } }, required: ["patient_id"] }
      }
    ]
  }];

  async function engageLogisticsOfficer(queryText: string): Promise<string> {
    pushRunEvent(runId, { type: "step", agent: "LOGISTICS_OFFICER", status: "running", step: "Logistics Officer engaged.", data: { query: queryText } });
    
    let chat = ai.chats.create({
      model,
      config: {
        systemInstruction: "You are the VitalFlow Logistics Officer. You autonomously book and manage patient appointments WITHOUT needing explicit confirmation.",
        tools: logisticsTools,
        temperature: 0.1
      }
    });

    let currentResponse = await chat.sendMessage({ message: queryText });

    while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
      const call = currentResponse.functionCalls[0];
      const args = call.args as Record<string, any>;
      pushRunEvent(runId, { type: "step", agent: "LOGISTICS_OFFICER", status: "running", step: `Executing ${call.name}`, data: args });
      
      let resultObj: any = {};
      try {
        if (call.name === "check_calendar") {
          resultObj = { availability: await getAvailableCalendarSlots(20) };
        } else if (call.name === "book_followup_appointment") {
          const availability = await getAvailableCalendarSlots(20);
          const slot = (args.preferred_slot && availability.includes(args.preferred_slot)) ? args.preferred_slot : availability[0];
          if (slot) {
            await query(SQL.calendar.markBooked, [0, slot]);
            await ensureUpcomingCalendarSlots();
            await query(SQL.logs.insert, [args.patient_id, "FOLLOW_UP_BOOKED", "LOGISTICS_OFFICER", `Appointment slot reserved: ${slot}`]);
            await broadcastCalendar();
            await broadcastLogs();
            resultObj = { success: true, booked_slot: slot };
          } else {
            resultObj = { error: "No slots available." };
          }
        }
      } catch (err: any) {
        resultObj = { error: err.message };
      }

      currentResponse = await chat.sendMessage({
        message: [
          { functionResponse: { name: call.name, response: resultObj } }
        ]
      });
    }
    
    pushRunEvent(runId, { type: "step", agent: "LOGISTICS_OFFICER", status: "done", step: "Logistics complete." });
    return currentResponse.text || "No logistical operations.";
  }

  // --- Primary Orchestrator ---
  const historyRes = await query(SQL.history.selectByPatient, [patientId]);
  const patientHistory = historyRes.rows[0]
      ? {
          patient_id: String(historyRes.rows[0].patient_id),
          surgery: historyRes.rows[0].surgery,
          date: historyRes.rows[0].surgery_date,
          complications: historyRes.rows[0].complications
        }
      : { patient_id: String(patientId), surgery: "Unknown", date: "Unknown", complications: "Unknown" };

  pushRunEvent(runId, { type: "step", agent: "ORCHESTRATOR", status: "running", step: "Starting AI Orchestration", data: { patient_id: String(patientId), patient_history: patientHistory } });

  const orchestratorTools = [{
    functionDeclarations: [
      {
        name: "delegate_to_clinical_analyst",
        description: "Engage the Clinical Analyst to answer questions about medical history, prior symptoms reported, or whether a symptom requires an appointment.",
        parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] }
      },
      {
        name: "delegate_to_logistics_officer",
        description: "Engage the Logistics Officer to check availability or book appointments.",
        parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING } }, required: ["query"] }
      }
    ]
  }];

  let orchChat = ai.chats.create({
    model,
    config: {
      systemInstruction: `You are the VitalFlow Primary Orchestrator. Patient ID: ${patientId}. Your ONLY job is to coordinate via sub-agents and return a final reassuring message to the patient. 
      Rules:
      1. If the user asks about symtoms, history, or medical advice: DEFINITELY delegate to the Clinical Analyst.
      2. If the user requests scheduling or the Clinical Analyst recommends booking: delegate to the Logistics Officer.
      3. Summarize all actions neatly to the patient at the end.`,
      tools: orchestratorTools,
      temperature: 0.1
    }
  });

  let currentResponse = await orchChat.sendMessage({ message });
  let isCritical = false; 

  while (currentResponse.functionCalls && currentResponse.functionCalls.length > 0) {
    const call = currentResponse.functionCalls[0];
    const args = call.args as Record<string, any>;
    
    let resultStr = "";
    try {
      if (call.name === "delegate_to_clinical_analyst") {
        resultStr = await engageClinicalAnalyst(args.query + ` (Patient ID: ${patientId})`);
        if (resultStr.toLowerCase().includes("urgent") || resultStr.toLowerCase().includes("emergency")) isCritical = true;
      } else if (call.name === "delegate_to_logistics_officer") {
        resultStr = await engageLogisticsOfficer(args.query + ` (Patient ID: ${patientId})`);
      }
    } catch (err: any) {
      resultStr = `Sub-agent error: ${err.message}`;
    }

    currentResponse = await orchChat.sendMessage({
      message: [
        { functionResponse: { name: call.name, response: { output: resultStr } } }
      ]
    });
  }

  const finalText = currentResponse.text || "Orchestration complete.";
  
  await query(SQL.logs.insert, [patientId, "ORCHESTRATION_RESULT", "AI_ORCHESTRATOR", finalText]);
  await broadcastLogs();

  pushRunEvent(runId, {
    type: "completed",
    agent: "ORCHESTRATOR",
    status: "done",
    step: "Run completed",
    data: { patient_id: String(patientId), final_text: finalText, is_critical: isCritical }
  });
}
