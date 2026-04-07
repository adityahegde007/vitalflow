import React, { useState, useEffect, useRef, useMemo } from "react";
import { 
  Activity, 
  Calendar, 
  ClipboardList, 
  Send, 
  AlertCircle, 
  User, 
  Database, 
  Cpu, 
  CheckCircle2,
  History,
  Info,
  Terminal,
  ShieldCheck,
  Zap,
  Clock,
  LayoutDashboard,
  FileText,
  ListTodo,
  ArrowRight
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import Markdown from "react-markdown";
import { GoogleGenAI, Type } from "@google/genai";

// 1. Orchestrator Configuration
const SYSTEM_INSTRUCTION = `
### ROLE
You are the "VitalFlow Care Orchestrator," a Multi-Agent Primary Coordinator built for the Google GenAI Academy APAC 2026. Your mission is to manage post-surgical recovery by coordinating sub-agents and tools via MCP.

### ARCHITECTURE (Separation of Concerns)
1. CLINICAL ANALYST (Sub-Agent): Queries the 'Recovery_Protocols' (via get_recovery_protocol) and 'Patient_History' (via get_patient_history).
2. LOGISTICS OFFICER (Sub-Agent): Executes actions. Manages 'Follow-up_Appointments' (via check_calendar) and 'Daily_Tasks' (via update_patient_task).

### OPERATIONAL WORKFLOW
- PHASE 1 (Assessment): When a patient provides an update, immediately invoke the CLINICAL ANALYST to cross-reference symptoms with AlloyDB records (via get_patient_history) and stored recovery notes (via get_recovery_protocol). You MUST call these tools first.
- PHASE 2 (Decision): 
    - If symptoms are "NORMAL": Reassure the patient and log the status in AlloyDB.
    - If symptoms are "CONCERNING": Invoke the LOGISTICS OFFICER to find the next available slot in the Service Account Calendar and create a Nurse-Alert task.
- PHASE 3 (Audit): Every action, tool call, and decision MUST be logged as a structured entry in the 'action_logs' table in AlloyDB.

### MOCK DATA CONSTRAINTS (For Jury Demo)
- Only process Patient IDs 100-110.
- If no Patient ID is provided, ask: "Please provide your Patient ID to begin your recovery check-in."

### SAFETY OVERRIDE
If the patient mentions "Chest Pain," "Shortness of Breath," or "Heavy Bleeding," immediately stop all tool processing and output: "CRITICAL ALARM: Contact Emergency Services (102) immediately. Your care team has been notified."
`;

const tools = [
  {
    functionDeclarations: [
      {
        name: "check_calendar",
        description: "Checks the Service Account Calendar for available follow-up appointment slots.",
        parameters: { type: Type.OBJECT, properties: {} }
      },
      {
        name: "get_recovery_protocol",
        description: "Reads the post-surgical recovery protocols from the clinical notes.",
        parameters: { type: Type.OBJECT, properties: {} }
      },
      {
        name: "get_patient_history",
        description: "Retrieves the patient's surgical history and past records from AlloyDB.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            patient_id: { type: Type.STRING, description: "The ID of the patient (100-110)." }
          },
          required: ["patient_id"]
        }
      },
      {
        name: "update_patient_task",
        description: "Logs an action or updates a patient task in the AlloyDB system.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            patient_id: { type: Type.STRING, description: "The ID of the patient (100-110)." },
            task: { type: Type.STRING, description: "The action or task being logged." },
            status: { type: Type.STRING, description: "The status of the action (e.g., NORMAL, CONCERNING, LOGGED)." },
            details: { type: Type.STRING, description: "Additional details about the assessment or action." }
          },
          required: ["patient_id", "task", "status", "details"]
        }
      }
    ]
  }
];

interface Message {
  role: "user" | "model";
  text: string;
  isCritical?: boolean;
  timestamp: string;
}

interface ActionLog {
  id: number;
  patient_id: string;
  action: string;
  status: string;
  details: string;
  created_at: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "model",
      text: "VITALFLOW SYSTEM ONLINE. Waiting for Patient ID to begin recovery assessment.",
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [patientId, setPatientId] = useState<string | null>(null);
  const [systemStatus, setSystemStatus] = useState({
    db: "checking",
    dbType: "Detecting...",
    ai: "online",
    calendar: "online"
  });
  
  // Dashboard Data
  const [protocol, setProtocol] = useState<string | null>(null);
  const [protocolError, setProtocolError] = useState<string | null>(null);
  const [patientHistory, setPatientHistory] = useState<any | null>(null);
  const [calendarSlots, setCalendarSlots] = useState<string[]>([]);
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [logs, setLogs] = useState<ActionLog[]>([]);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [systemLogs, setSystemLogs] = useState<string[]>([]);
  const [activeAgent, setActiveAgent] = useState<"ORCHESTRATOR" | "CLINICAL_ANALYST" | "LOGISTICS_OFFICER">("ORCHESTRATOR");

  const scrollRef = useRef<HTMLDivElement>(null);

  // 2. Initialize Gemini SDK
  const apiKey = process.env.GEMINI_API_KEY;
  const isApiKeyMissing = !apiKey || apiKey === "undefined";

  const ai = useMemo(() => new GoogleGenAI({ apiKey: apiKey || "" }), [apiKey]);
  const chat = useMemo(() => {
    if (isApiKeyMissing) return null;
    return ai.chats.create({
      model: "gemini-3-flash-preview",
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        tools: tools
      }
    });
  }, [ai, isApiKeyMissing]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Initial Health Check & Logs Fetch
  useEffect(() => {
    const fetchHealth = async () => {
      try {
        let res = await fetch("/api/health");
        let text = await res.text().catch(() => "No response body");
        
        // If /api/health fails with 401, try /healthz (no prefix)
        if (!res.ok && res.status === 401) {
          console.warn("API health check 401, trying /healthz...");
          const res2 = await fetch("/healthz");
          if (res2.ok) {
            const data = await res2.json();
            setSystemStatus(prev => ({ 
              ...prev, 
              db: data.status === "ok" ? "online" : "error",
              dbType: `(Bypassed Proxy) ${data.db || "Unknown"}`
            }));
            return;
          }
          // If both fail, show the original 401
        }

        if (!res.ok) {
          setSystemStatus(prev => ({ 
            ...prev, 
            db: "error", 
            dbType: `HTTP ${res.status}: ${text.substring(0, 50)}` 
          }));
          return;
        }
        const data = JSON.parse(text);
        setSystemStatus(prev => ({ 
          ...prev, 
          db: data.status === "healthy" ? "online" : "error",
          dbType: data.database || "Unknown"
        }));
      } catch (e: any) {
        console.error("Health check failed:", e);
        setSystemStatus(prev => ({ ...prev, db: "offline", dbType: e.message || "Connection Failed" }));
      }
    };

    const fetchLogs = async () => {
      try {
        const res = await fetch("/api/logs");
        if (res.ok) {
          const data = await res.json();
          setLogs(data);
          setLogsError(null);
        } else {
          setLogsError(`Server Error: ${res.status}`);
        }
      } catch (e) {
        console.error("Failed to fetch logs:", e);
        setLogsError("Network Error: Failed to reach backend.");
      }
    };

    const fetchProtocol = async () => {
      try {
        const res = await fetch("/api/tools/protocol");
        if (res.ok) {
          const data = await res.json();
          if (data.protocol) {
            setProtocol(data.protocol);
            setProtocolError(null);
          } else if (data.error) {
            setProtocolError(data.error);
          }
        } else {
          setProtocolError(`Server Error: ${res.status}`);
        }
      } catch (e) {
        console.error("Failed to fetch protocol:", e);
        setProtocolError("Network Error: Failed to reach backend.");
      }
    };

    const fetchCalendar = async () => {
      try {
        const res = await fetch("/api/tools/calendar");
        if (res.ok) {
          const data = await res.json();
          if (data.availability) {
            setCalendarSlots(data.availability);
            setCalendarError(null);
          } else if (data.message) {
            setCalendarError(data.message);
          }
        } else {
          setCalendarError(`Server Error: ${res.status}`);
        }
      } catch (e) {
        console.error("Failed to fetch calendar:", e);
        setCalendarError("Network Error: Failed to reach backend.");
      }
    };

    const fetchSystemLogs = async () => {
      try {
        const res = await fetch("/api/system-logs");
        if (res.ok) {
          const data = await res.json();
          setSystemLogs(data.logs || []);
        }
      } catch (e) {
        console.error("Failed to fetch system logs:", e);
      }
    };

    const init = () => {
      fetchHealth();
      fetchLogs();
      fetchProtocol();
      fetchCalendar();
      fetchSystemLogs();
    };

    init();
    const interval = setInterval(() => {
      fetchLogs();
      fetchSystemLogs();
    }, 5000); // Poll for logs
    return () => clearInterval(interval);
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: Message = { 
      role: "user", 
      text: input, 
      timestamp: new Date().toLocaleTimeString() 
    };
    
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setActiveAgent("ORCHESTRATOR");

    try {
      if (isApiKeyMissing || !chat) {
        throw new Error("401: Gemini API Key is missing or invalid. Please check your environment variables.");
      }

      let response = await chat.sendMessage({ message: input });
      
      // Handle Tool Calls
      let functionCalls = response.functionCalls;
      while (functionCalls) {
        const toolResults = await Promise.all(functionCalls.map(async (call) => {
          let result;
          if (call.name === "check_calendar") {
            setActiveAgent("LOGISTICS_OFFICER");
            const res = await fetch("/api/tools/calendar");
            result = await res.json();
            if (result.availability) setCalendarSlots(result.availability);
          } else if (call.name === "get_recovery_protocol") {
            setActiveAgent("CLINICAL_ANALYST");
            const res = await fetch("/api/tools/protocol");
            result = await res.json();
            if (result.protocol) setProtocol(result.protocol);
          } else if (call.name === "get_patient_history") {
            setActiveAgent("CLINICAL_ANALYST");
            const res = await fetch(`/api/tools/patient-history/${call.args.patient_id}`);
            result = await res.json();
            setPatientHistory(result);
          } else if (call.name === "update_patient_task") {
            setActiveAgent("LOGISTICS_OFFICER");
            const res = await fetch("/api/tools/log-task", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(call.args)
            });
            result = await res.json();
          }
          return { name: call.name, response: result };
        }));

        response = await chat.sendMessage({
          message: toolResults.map(r => ({
            functionResponse: { name: r.name, response: r.response }
          })) as any 
        });
        functionCalls = response.functionCalls;
      }

      const modelText = response.text || "I'm sorry, I couldn't process that.";
      const isCritical = modelText.includes("CRITICAL ALARM");

      const idMatch = input.match(/\b(10[0-9]|110)\b/);
      if (idMatch) setPatientId(idMatch[0]);

      setMessages((prev) => [...prev, { 
        role: "model", 
        text: modelText, 
        isCritical,
        timestamp: new Date().toLocaleTimeString()
      }]);
      setActiveAgent("ORCHESTRATOR");
    } catch (error: any) {
      console.error("Gemini Error:", error);
      const errorMessage = error.message?.includes("401") 
        ? "AUTHENTICATION ERROR (401): Gemini API Key is missing or invalid. Please check your environment variables."
        : "ORCHESTRATION ERROR: Unable to process clinical reasoning.";
      
      setMessages((prev) => [...prev, { 
        role: "model", 
        text: errorMessage,
        timestamp: new Date().toLocaleTimeString()
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden bg-[#E4E3E0] text-[#141414] font-sans">
      {/* Sidebar - Technical Control Panel */}
      <aside className="w-72 border-r border-[#141414] flex flex-col bg-white shrink-0">
        <div className="p-6 border-b border-[#141414]">
          <div className="flex items-center gap-2 mb-1">
            <Activity className="w-5 h-5 text-blue-600" />
            <h1 className="font-bold tracking-tighter text-xl uppercase">VitalFlow</h1>
          </div>
          <p className="mono-label">Care Orchestration v2.5</p>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Patient Context */}
          <section className="p-6 border-b border-[#141414]">
            <h2 className="italic-header mb-4">Patient Identity</h2>
            <div className="flex items-center gap-3 p-3 border border-[#141414] bg-[#F5F5F5]">
              <div className="w-10 h-10 bg-[#141414] flex items-center justify-center text-white">
                <User className="w-5 h-5" />
              </div>
              <div>
                <p className="mono-label">Active ID</p>
                <p className="font-mono font-bold">{patientId || "NOT_SET"}</p>
              </div>
            </div>
          </section>

          {/* System Status */}
          <section className="p-6 border-b border-[#141414]">
            <div className="flex items-center justify-between mb-4">
              <h2 className="italic-header">Core Systems</h2>
            </div>
            <div className="space-y-3">
              <StatusItem 
                icon={<Database className="w-4 h-4" />} 
                label="Database" 
                status={systemStatus.db} 
                subtext={systemStatus.dbType}
              />
              <StatusItem icon={<Cpu className="w-4 h-4" />} label="Gemini SDK" status={systemStatus.ai} />
              <StatusItem icon={<Calendar className="w-4 h-4" />} label="MCP Calendar" status={systemStatus.calendar} />
            </div>
          </section>

          {/* Agent Dispatch Monitor */}
          <section className="p-6 border-b border-[#141414]">
            <h2 className="italic-header mb-4">Agent Dispatch</h2>
            <div className="space-y-2">
              <AgentNode label="Orchestrator" active={activeAgent === "ORCHESTRATOR"} />
              <AgentNode label="Clinical Analyst" active={activeAgent === "CLINICAL_ANALYST"} />
              <AgentNode label="Logistics Officer" active={activeAgent === "LOGISTICS_OFFICER"} />
            </div>
          </section>
        </div>

        <div className="p-6 border-t border-[#141414] bg-[#F5F5F5]">
          <div className="flex items-center gap-2 text-xs opacity-50 font-mono">
            <Info className="w-3 h-3" />
            <span>APAC 2026 DEMO BUILD</span>
          </div>
        </div>
      </aside>

      {/* Main Content - Data Grid Chat */}
      <main className="flex-1 flex flex-col min-w-0 border-r border-[#141414]">
        {/* Header Bar */}
        <header className="h-16 border-b border-[#141414] bg-white flex items-center justify-between px-8">
          <div className="flex items-center gap-4">
            <LayoutDashboard className="w-4 h-4 opacity-40" />
            <span className="mono-label">Orchestrator Node</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></span>
            <span className="mono-label">Real-time Sync Active</span>
          </div>
        </header>

        {/* Message Area */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-8 space-y-6 bg-white/50"
        >
          <AnimatePresence initial={false}>
            {messages.map((msg, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"}`}
              >
                <div className="flex items-center gap-2 mb-1 px-1">
                  <span className="mono-label">{msg.role === "user" ? "Patient" : "Orchestrator"}</span>
                  <span className="text-[10px] opacity-30 font-mono">{msg.timestamp}</span>
                </div>
                
                <div className={`
                  max-w-[90%] p-4 border border-[#141414] shadow-[4px_4px_0px_0px_rgba(20,20,20,0.1)]
                  ${msg.role === "user" ? "bg-white" : "bg-[#141414] text-white"}
                  ${msg.isCritical ? "border-red-500 ring-2 ring-red-500/20" : ""}
                `}>
                  {msg.isCritical && (
                    <div className="flex items-center gap-2 text-red-400 mb-2 font-bold text-xs uppercase tracking-widest">
                      <AlertCircle className="w-4 h-4" />
                      Critical Alarm
                    </div>
                  )}
                  <div className="prose prose-sm prose-invert max-w-none">
                    <Markdown>{msg.text}</Markdown>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isLoading && (
            <div className="flex items-center gap-3 text-[#141414] opacity-40">
              <Activity className="w-4 h-4 animate-spin" />
              <span className="mono-label">Dispatching Sub-Agents...</span>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-8 bg-white border-t border-[#141414]">
          <form 
            onSubmit={(e) => { e.preventDefault(); handleSend(); }} 
            className="relative"
          >
            <div className="absolute left-4 top-1/2 -translate-y-1/2 text-[#141414] opacity-30">
              <Terminal className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              placeholder="Enter patient update or symptom report..."
              className="w-full p-4 pl-12 pr-16 border border-[#141414] bg-[#F5F5F5] focus:outline-none focus:ring-2 focus:ring-blue-500/20 font-mono text-sm"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 top-2 bottom-2 px-4 bg-[#141414] text-white hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
            </button>
          </form>
          <div className="mt-3 flex gap-4">
            <QuickAction label="Check Protocol" onClick={() => setInput("What is the recovery protocol?")} />
            <QuickAction label="Check Calendar" onClick={() => setInput("Check my follow-up availability")} />
            <QuickAction label="Log Symptom" onClick={() => setInput("I have a slight fever (Patient 101)")} />
          </div>
        </div>
      </main>

      {/* Right Sidebar - Live Context Feed */}
      <aside className="w-96 flex flex-col bg-white shrink-0">
        <header className="h-16 border-b border-[#141414] flex items-center px-6">
          <Terminal className="w-4 h-4 mr-2" />
          <h2 className="font-bold tracking-tighter uppercase text-sm">Live Context Feed</h2>
        </header>

        <div className="flex-1 overflow-y-auto">
          {/* Patient History (AlloyDB MCP) */}
          <section className="p-6 border-b border-[#141414]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="italic-header flex items-center gap-2">
                <User className="w-4 h-4" /> Patient History
              </h3>
              <span className="mono-label text-[10px]">ALLOYDB MCP</span>
            </div>
            <div className="p-4 border border-[#141414] bg-[#F5F5F5] min-h-[80px]">
              {patientHistory ? (
                <div className="text-xs font-mono space-y-1">
                  <p><span className="font-bold">Surgery:</span> {patientHistory.surgery}</p>
                  <p><span className="font-bold">Date:</span> {patientHistory.date}</p>
                  <p><span className="font-bold">Complications:</span> {patientHistory.complications}</p>
                </div>
              ) : (
                <p className="text-xs opacity-40 italic">No history retrieved yet.</p>
              )}
            </div>
          </section>

          {/* Recovery Protocol (Notes MCP) */}
          <section className="p-6 border-b border-[#141414]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="italic-header flex items-center gap-2">
                <FileText className="w-4 h-4" /> Recovery Protocol
              </h3>
              <span className="mono-label text-[10px]">NOTES MCP</span>
            </div>
            <div className="p-4 border border-[#141414] bg-[#F5F5F5] min-h-[100px] max-h-[200px] overflow-y-auto">
              {protocol ? (
                <div className="prose prose-xs">
                  <Markdown>{protocol}</Markdown>
                </div>
              ) : protocolError ? (
                <p className="text-xs text-red-600 italic">{protocolError}</p>
              ) : (
                <p className="text-xs opacity-40 italic">No protocol data retrieved yet.</p>
              )}
            </div>
          </section>

          {/* Calendar Slots (Calendar MCP) */}
          <section className="p-6 border-b border-[#141414]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="italic-header flex items-center gap-2">
                <Calendar className="w-4 h-4" /> Follow-up Slots
              </h3>
              <span className="mono-label text-[10px]">CALENDAR MCP</span>
            </div>
            <div className="space-y-2">
              {calendarSlots.length > 0 ? (
                calendarSlots.map((slot, i) => (
                  <div key={i} className="flex items-center justify-between p-2 border border-[#141414] bg-white">
                    <span className="text-xs font-mono">{new Date(slot).toLocaleString()}</span>
                    <ArrowRight className="w-3 h-3 opacity-30" />
                  </div>
                ))
              ) : calendarError ? (
                <p className="text-xs text-red-600 italic">{calendarError}</p>
              ) : (
                <p className="text-xs opacity-40 italic">No availability checked.</p>
              )}
            </div>
          </section>

          {/* Audit Trail (AlloyDB MCP) */}
          <section className="p-6 border-b border-[#141414]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="italic-header flex items-center gap-2">
                <History className="w-4 h-4" /> Audit Trail
              </h3>
              <span className="mono-label text-[10px]">ALLOYDB MCP</span>
            </div>
            <div className="space-y-3">
              {logs.length > 0 ? (
                logs.map((log) => (
                  <div key={log.id} className="p-3 border border-[#141414] bg-[#F5F5F5] relative overflow-hidden">
                    <div className="flex justify-between items-start mb-1">
                      <span className="text-[10px] font-bold uppercase tracking-widest">{log.action}</span>
                      <span className="text-[9px] opacity-40 font-mono">{new Date(log.created_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-[11px] leading-tight mb-1">{log.details}</p>
                    <div className="flex items-center gap-2">
                      <span className={`text-[9px] px-1 font-mono ${
                        log.status === "NORMAL" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"
                      }`}>
                        {log.status}
                      </span>
                      <span className="text-[9px] opacity-30 font-mono">PID: {log.patient_id}</span>
                    </div>
                  </div>
                ))
              ) : logsError ? (
                <div className="p-3 border border-red-200 bg-red-50 text-red-700">
                  <p className="text-xs font-bold mb-1">CONNECTION ERROR</p>
                  <p className="text-[10px] leading-tight">{logsError}</p>
                </div>
              ) : (
                <p className="text-xs opacity-40 italic">No logs found in database.</p>
              )}
            </div>
          </section>

          {/* System Logs (Debug) */}
          <section className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="italic-header flex items-center gap-2 text-blue-600">
                <Terminal className="w-4 h-4" /> System Diagnostics
              </h3>
              <span className="mono-label text-[10px]">BACKEND LOGS</span>
            </div>
            <div className="p-3 border border-[#141414] bg-[#141414] text-[#00FF00] font-mono text-[9px] h-48 overflow-y-auto">
              {systemLogs.length > 0 ? (
                systemLogs.map((log, i) => (
                  <div key={i} className="mb-1 border-b border-white/10 pb-1 last:border-0">
                    {log}
                  </div>
                ))
              ) : (
                <p className="opacity-40 italic">Waiting for system logs...</p>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

const StatusItem: React.FC<{ icon: React.ReactNode, label: string, status: string, subtext?: string }> = ({ icon, label, status, subtext }) => (
  <div className="flex items-center justify-between p-2 border border-[#141414]/10 rounded">
    <div className="flex items-center gap-2">
      <span className="opacity-40">{icon}</span>
      <div>
        <p className="text-xs font-medium leading-none">{label}</p>
        {subtext && <p className="text-[9px] font-mono opacity-40 mt-1">{subtext}</p>}
      </div>
    </div>
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
      status === "online" ? "bg-green-100 text-green-700" : 
      status === "checking" ? "bg-blue-100 text-blue-700" : "bg-red-100 text-red-700"
    }`}>
      {status.toUpperCase()}
    </span>
  </div>
);

const AgentNode: React.FC<{ label: string, active: boolean }> = ({ label, active }) => (
  <div className={`flex items-center gap-3 p-2 border transition-all ${
    active ? "border-[#141414] bg-[#141414] text-white" : "border-[#141414]/10 bg-white opacity-40"
  }`}>
    <div className={`w-2 h-2 rounded-full ${active ? "bg-green-400 animate-pulse" : "bg-gray-300"}`}></div>
    <span className="text-[10px] font-bold uppercase tracking-widest">{label}</span>
  </div>
);

const QuickAction: React.FC<{ label: string, onClick: () => void }> = ({ label, onClick }) => (
  <button 
    onClick={onClick}
    className="text-[10px] font-mono uppercase tracking-wider border border-[#141414]/20 px-2 py-1 hover:bg-[#141414] hover:text-white transition-colors"
  >
    {label}
  </button>
);
