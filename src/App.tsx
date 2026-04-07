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
  Terminal,
  Zap,
  Clock,
  FileText
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
- PHASE 2 (Memory & Context): If the user asks about previous symptoms, logs, or "what happened before," you MUST use the 'get_action_logs' tool to retrieve the patient's history from the database. This is your primary memory mechanism.
- PHASE 3 (Decision): 
    - If symptoms are "NORMAL": Reassure the patient and log the status in AlloyDB.
    - If symptoms are "CONCERNING": Invoke the LOGISTICS OFFICER to find the next available slot in the Service Account Calendar and create a Nurse-Alert task.
- PHASE 4 (Audit): Every action, tool call, and decision MUST be logged as a structured entry in the 'action_logs' table in AlloyDB.

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
        name: "get_action_logs",
        description: "Retrieves the most recent action logs for a specific patient from AlloyDB. Use this to 'remember' what the patient previously reported.",
        parameters: {
          type: Type.OBJECT,
          properties: {
            patient_id: { type: Type.STRING, description: "The ID of the patient (100-110)." },
            limit: { type: Type.NUMBER, description: "Number of logs to retrieve (default 5)." }
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
const LOG_POLL_INTERVAL_MS = 5000;

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

type Persona = "ORCHESTRATOR" | "CLINICAL_ANALYST" | "LOGISTICS_OFFICER";

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
  const [activeAgent, setActiveAgent] = useState<Persona>("ORCHESTRATOR");
  const [activeTab, setActiveTab] = useState<Persona>("ORCHESTRATOR");

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
        
        if (!res.ok && res.status === 401) {
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
        }
      } catch (e) {
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
          }
        }
      } catch (e) {
        setCalendarError("Network Error: Failed to reach backend.");
      }
    };

    const init = () => {
      void Promise.all([fetchHealth(), fetchLogs(), fetchProtocol(), fetchCalendar()]);
    };
    const fetchLogsIfVisible = () => {
      if (document.visibilityState === "visible") {
        void fetchLogs();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void fetchLogs();
      }
    };

    init();
    const interval = setInterval(fetchLogsIfVisible, LOG_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
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
      if (!chat) throw new Error("401: Gemini API Key is missing or invalid. Please set GEMINI_API_KEY in Settings.");
      
      let response = await chat.sendMessage({ message: input });
      
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
          } else if (call.name === "get_action_logs") {
            setActiveAgent("ORCHESTRATOR");
            const res = await fetch(`/api/tools/action-logs/${call.args.patient_id}?limit=${call.args.limit || 5}`);
            result = await res.json();
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

        if (!chat) throw new Error("Chat session lost.");
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

  const personaDetails = {
    ORCHESTRATOR: {
      title: "VitalFlow Orchestrator",
      icon: <Zap className="w-5 h-5" />,
      responsibilities: [
        "Primary interface for patient communication",
        "Coordinates sub-agents and tool execution",
        "Maintains system-wide context and memory",
        "Enforces safety protocols and critical alarms"
      ],
      color: "bg-blue-600"
    },
    CLINICAL_ANALYST: {
      title: "Clinical Analyst",
      icon: <Activity className="w-5 h-5" />,
      responsibilities: [
        "Analyzes patient history and recovery protocols",
        "Identifies concerning symptoms and trends",
        "Cross-references data with clinical guidelines",
        "Provides medical reasoning to the Orchestrator"
      ],
      color: "bg-emerald-600"
    },
    LOGISTICS_OFFICER: {
      title: "Logistics Officer",
      icon: <ClipboardList className="w-5 h-5" />,
      responsibilities: [
        "Manages scheduling and calendar availability",
        "Logs patient tasks and assessment results",
        "Triggers nurse alerts and follow-up actions",
        "Handles data persistence in AlloyDB"
      ],
      color: "bg-amber-600"
    }
  };

  return (
    <div className="flex h-[100dvh] flex-col lg:flex-row overflow-hidden bg-[#F1F5F9] text-[#0F172A] font-sans">
      {/* Sidebar - Technical Control Panel */}
      <aside className="hidden lg:flex w-80 border-r border-slate-200 flex-col bg-[#1E293B] text-white shrink-0 shadow-2xl z-20">
        <div className="p-6 border-b border-white/5">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 bg-blue-600 rounded-xl shadow-lg shadow-blue-500/20">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="font-bold tracking-tight text-xl text-white">VitalFlow</h1>
              <p className="text-[10px] font-mono text-blue-400 uppercase tracking-widest">Care Orchestration 2.5</p>
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* Patient Context */}
          <section className="p-6 border-b border-white/5">
            <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Patient Identity</h2>
            <div className="flex items-center gap-4 p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-sm">
              <div className="w-12 h-12 rounded-full bg-white/10 shadow-inner flex items-center justify-center text-blue-400">
                <User className="w-6 h-6" />
              </div>
              <div>
                <p className="text-[10px] font-mono text-slate-500">Active Session ID</p>
                <p className="font-mono font-bold text-lg text-white">{patientId || "---"}</p>
              </div>
            </div>
          </section>

          {/* Agent Dispatch Monitor */}
          <section className="p-6 border-b border-white/5">
            <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Active Dispatch</h2>
            <div className="space-y-2">
              <AgentNode label="Orchestrator" active={activeAgent === "ORCHESTRATOR"} color="bg-blue-600" />
              <AgentNode label="Clinical Analyst" active={activeAgent === "CLINICAL_ANALYST"} color="bg-emerald-600" />
              <AgentNode label="Logistics Officer" active={activeAgent === "LOGISTICS_OFFICER"} color="bg-amber-600" />
            </div>
          </section>

          {/* System Status */}
          <section className="p-6">
            <h2 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-4">Core Systems</h2>
            <div className="space-y-3">
              <StatusItem 
                icon={<Database className="w-4 h-4" />} 
                label="AlloyDB" 
                status={systemStatus.db} 
                subtext={systemStatus.dbType}
                dark
              />
              <StatusItem icon={<Cpu className="w-4 h-4" />} label="Gemini 3.0" status={systemStatus.ai} dark />
              <StatusItem icon={<Calendar className="w-4 h-4" />} label="MCP Calendar" status={systemStatus.calendar} dark />
            </div>
          </section>
        </div>

      </aside>

      {/* Main Content - Persona Tabs & Chat */}
      <main className="flex-1 flex flex-col min-w-0 bg-[#F1F5F9]">
        {/* Persona Tabs */}
        <div className="flex border-b border-slate-200 bg-white/80 backdrop-blur-md sticky top-0 z-10">
          {(Object.keys(personaDetails) as Persona[]).map((p) => (
            <button
              key={p}
              onClick={() => setActiveTab(p)}
              className={`flex-1 py-4 px-6 text-sm font-bold transition-all border-b-2 flex items-center justify-center gap-2 ${
                activeTab === p 
                  ? `border-blue-600 text-blue-600 bg-white shadow-[0_-4px_0_0_inset_white]` 
                  : "border-transparent text-slate-400 hover:text-slate-600 hover:bg-slate-50"
              }`}
            >
              <span className={activeTab === p ? "text-blue-600" : "text-slate-400"}>
                {personaDetails[p].icon}
              </span>
              <span className="hidden sm:inline">{personaDetails[p].title}</span>
            </button>
          ))}
        </div>

        {isApiKeyMissing && (
          <div className="bg-amber-50 border-b border-amber-100 p-3 flex items-center gap-3 text-amber-800 text-xs font-medium">
            <AlertCircle className="w-4 h-4 text-amber-500" />
            <span>
              Gemini API Key missing. Please set GEMINI_API_KEY in Settings.
            </span>
          </div>
        )}

        {/* Persona Responsibilities Header */}
        <div className="p-4 sm:p-6 bg-white border-b border-slate-200">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-bold flex items-center gap-2">
                {personaDetails[activeTab].icon}
                {personaDetails[activeTab].title}
              </h2>
              <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">Active Protocol & Responsibilities</p>
            </div>
            <div className={`px-3 py-1 rounded-full text-[10px] font-bold text-white uppercase tracking-widest ${personaDetails[activeTab].color}`}>
              {activeTab === activeAgent ? "Processing" : "Standby"}
            </div>
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-2 mt-3">
            {personaDetails[activeTab].responsibilities.map((r, i) => (
              <div key={i} className="flex items-center gap-2 text-[10px] text-slate-500">
                <CheckCircle2 className="w-3 h-3 text-blue-500" />
                {r}
              </div>
            ))}
          </div>
        </div>

        {/* Message Area */}
        <div 
          ref={scrollRef}
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 sm:space-y-6"
        >
          <AnimatePresence initial={false}>
            {messages.map((msg, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div className={`flex flex-col ${msg.role === "user" ? "items-end" : "items-start"} max-w-[95%] sm:max-w-[80%]`}>
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">
                      {msg.role === "user" ? "Patient" : "VitalFlow AI"}
                    </span>
                    <span className="text-[10px] text-gray-300 font-mono">{msg.timestamp}</span>
                  </div>
                  
                  <div className={`
                    p-4 sm:p-5 rounded-2xl shadow-sm border
                    ${msg.role === "user" 
                      ? "bg-blue-600 text-white border-blue-700 rounded-tr-none" 
                      : "bg-white text-gray-800 border-gray-100 rounded-tl-none"}
                    ${msg.isCritical ? "ring-4 ring-red-500/20 border-red-500" : ""}
                  `}>
                    {msg.isCritical && (
                      <div className="flex items-center gap-2 text-red-500 mb-3 font-bold text-xs uppercase tracking-widest">
                        <AlertCircle className="w-4 h-4" />
                        Critical Medical Alert
                      </div>
                    )}
                    <div className={`prose prose-sm max-w-none ${msg.role === "user" ? "prose-invert" : ""}`}>
                      <Markdown>{msg.text}</Markdown>
                    </div>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
          {isLoading && (
            <div className="flex items-center gap-3 text-blue-600">
              <div className="flex gap-1">
                <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.3s]"></div>
                <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce [animation-delay:-0.15s]"></div>
                <div className="w-1.5 h-1.5 bg-blue-600 rounded-full animate-bounce"></div>
              </div>
              <span className="text-[10px] font-bold uppercase tracking-widest">Agent {activeAgent.replace("_", " ")} Processing...</span>
            </div>
          )}
        </div>

        {/* Input Area */}
        <div className="p-3 sm:p-6 bg-white border-t border-gray-100">
          <form 
            onSubmit={(e) => { e.preventDefault(); handleSend(); }} 
            className="flex gap-2 sm:gap-4"
          >
            <div className="relative flex-1">
              <div className="absolute left-3 sm:left-4 top-1/2 -translate-y-1/2 text-gray-400">
                <Terminal className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Type your health update or question..."
                className="w-full p-3 sm:p-4 pl-10 sm:pl-12 pr-3 sm:pr-4 bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-sm"
              />
            </div>
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="p-3 sm:p-4 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-all disabled:opacity-50 shadow-lg shadow-blue-500/20"
            >
              <Send className="w-5 h-5" />
            </button>
          </form>
          <div className="mt-4 flex flex-wrap gap-2">
            <QuickAction label="Check Protocol" onClick={() => setInput("What is the recovery protocol?")} />
            <QuickAction label="Check Calendar" onClick={() => setInput("Check my follow-up availability")} />
            <QuickAction label="Log Symptom" onClick={() => setInput("I have a slight fever (Patient 101)")} />
            <QuickAction label="Recall History" onClick={() => setInput("What symptoms did I report earlier?")} />
          </div>
        </div>
      </main>

      {/* Right Sidebar - Live Context Feed */}
      <aside className="hidden xl:flex w-96 flex-col bg-[#F1F5F9] shrink-0 border-l border-slate-200">
        <header className="h-16 border-b border-slate-200 flex items-center px-6 bg-white">
          <History className="w-4 h-4 mr-2 text-slate-400" />
          <h2 className="font-bold tracking-tight uppercase text-[10px] text-slate-500 tracking-widest">Clinical Audit Feed</h2>
        </header>

        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Patient History */}
          <ContextCard 
            title="Patient History" 
            icon={<User className="w-4 h-4" />} 
            mcp="ALLOYDB"
            content={patientHistory ? (
              <div className="text-xs space-y-2">
                <div className="flex justify-between"><span className="text-gray-400">Surgery:</span> <span className="font-medium">{patientHistory.surgery}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Date:</span> <span className="font-medium">{patientHistory.date}</span></div>
                <div className="flex justify-between"><span className="text-gray-400">Complications:</span> <span className="font-medium">{patientHistory.complications}</span></div>
              </div>
            ) : null}
          />

          {/* Recovery Protocol */}
          <ContextCard 
            title="Recovery Protocol" 
            icon={<FileText className="w-4 h-4" />} 
            mcp="NOTES"
            content={protocol ? (
              <div className="prose prose-xs max-h-40 overflow-y-auto">
                <Markdown>{protocol}</Markdown>
              </div>
            ) : null}
          />

          {/* Calendar Availability */}
          <ContextCard 
            title="Calendar Availability" 
            icon={<Calendar className="w-4 h-4" />} 
            mcp="CALENDAR"
            content={calendarSlots.length > 0 ? (
              <div className="space-y-2">
                {calendarSlots.map((slot, i) => (
                  <div key={i} className="flex items-center gap-2 text-[10px] p-2 bg-blue-50/50 rounded-lg border border-blue-100/50 text-blue-700">
                    <Clock className="w-3 h-3" />
                    {slot}
                  </div>
                ))}
              </div>
            ) : null}
          />

          {/* Audit Trail */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[10px] font-bold text-gray-400 uppercase tracking-widest">Global Audit Trail</h3>
                <p className="text-[8px] text-gray-400 mt-0.5 italic">System-wide clinical events</p>
              </div>
              <span className="text-[9px] font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">LIVE</span>
            </div>
            <div className="space-y-3">
              {logs.length > 0 ? (
                logs.map((log) => (
                  <div key={log.id} className="p-4 rounded-xl bg-white border border-gray-100 shadow-sm relative overflow-hidden group">
                    <div className="flex justify-between items-start mb-2">
                      <span className="text-[10px] font-bold text-blue-600 uppercase tracking-widest">{log.action}</span>
                      <span className="text-[9px] text-gray-300 font-mono">{new Date(log.created_at).toLocaleTimeString()}</span>
                    </div>
                    <p className="text-xs text-gray-600 leading-relaxed mb-3">{log.details}</p>
                    <div className="flex items-center justify-between">
                      <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                        log.status === "NORMAL" ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"
                      }`}>
                        {log.status}
                      </span>
                      <span className="text-[9px] text-gray-300 font-mono">PID: {log.patient_id}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="p-8 text-center border-2 border-dashed border-gray-200 rounded-2xl">
                  <Clock className="w-8 h-8 text-gray-200 mx-auto mb-2" />
                  <p className="text-xs text-gray-400 italic">Waiting for clinical events...</p>
                </div>
              )}
            </div>
          </section>
        </div>
      </aside>
    </div>
  );
}

const ContextCard: React.FC<{ title: string, icon: React.ReactNode, mcp: string, content: React.ReactNode }> = ({ title, icon, mcp, content }) => (
  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
    <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between bg-gray-50/50">
      <div className="flex items-center gap-2 text-gray-600">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{title}</span>
      </div>
      <span className="text-[8px] font-mono text-gray-400">{mcp} MCP</span>
    </div>
    <div className="p-4">
      {content || <p className="text-[10px] text-gray-300 italic">No data retrieved yet.</p>}
    </div>
  </div>
);

const StatusItem: React.FC<{ icon: React.ReactNode, label: string, status: string, subtext?: string, dark?: boolean }> = ({ icon, label, status, subtext, dark }) => (
  <div className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
    dark ? "bg-white/5 border-white/10 text-white" : "bg-white border-gray-100 text-gray-700 shadow-sm"
  }`}>
    <div className="flex items-center gap-3">
      <div className={dark ? "text-blue-400" : "text-gray-400"}>{icon}</div>
      <div>
        <p className="text-xs font-bold">{label}</p>
        {subtext && <p className={`text-[9px] font-mono mt-0.5 truncate max-w-[120px] ${dark ? "text-gray-500" : "text-gray-400"}`}>{subtext}</p>}
      </div>
    </div>
    <div className={`w-2 h-2 rounded-full ${
      status === "online" ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : 
      status === "checking" ? "bg-blue-500 animate-pulse" : "bg-red-500"
    }`}></div>
  </div>
);

const AgentNode: React.FC<{ label: string, active: boolean, color: string }> = ({ label, active, color }) => (
  <div className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
    active ? `border-white/20 ${color} shadow-lg` : "border-white/5 bg-white/5 opacity-60"
  }`}>
    <div className="flex items-center gap-3">
      <div className={`w-2 h-2 rounded-full ${active ? "bg-white animate-pulse shadow-[0_0_8px_white]" : "bg-slate-600"}`}></div>
      <span className={`text-[10px] font-bold uppercase tracking-widest ${active ? "text-white" : "text-slate-400"}`}>{label}</span>
    </div>
    {active && <Zap className="w-3 h-3 text-white" />}
  </div>
);

const QuickAction: React.FC<{ label: string, onClick: () => void }> = ({ label, onClick }) => (
  <button 
    onClick={onClick}
    className="text-[10px] font-bold uppercase tracking-wider border border-gray-200 px-3 py-1.5 rounded-lg hover:border-blue-500 hover:text-blue-600 hover:bg-blue-50 transition-all bg-white shadow-sm"
  >
    {label}
  </button>
);
