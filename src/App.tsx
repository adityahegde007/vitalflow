import React, { useState, useEffect, useRef } from "react";
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
 

function extractPatientId(text: string): string | null {
  const explicit = text.match(/patient(?:\s*id)?\s*[:#-]?\s*(\d{1,6})/i);
  if (explicit) return explicit[1];
  const fallback = text.match(/\b(\d{1,6})\b/);
  return fallback ? fallback[1] : null;
}

import type { Message, ActionLog, Persona } from "./types";
import { ContextCard } from "./components/ContextCard";
import { StatusItem } from "./components/StatusItem";
import { AgentNode } from "./components/AgentNode";
import { QuickAction } from "./components/QuickAction";
import { PresentationView } from "./components/PresentationView";


export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
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
  const runStreamRef = useRef<EventSource | null>(null);

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

    init();

    const logStream = new EventSource("/api/stream/logs");
    logStream.addEventListener("logs", (event) => {
      try {
        const nextLogs = JSON.parse((event as MessageEvent).data) as ActionLog[];
        setLogs(nextLogs);
        setLogsError(null);
      } catch {
        setLogsError("Stream parse error.");
      }
    });
    logStream.addEventListener("calendar", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent).data) as { availability?: string[] };
        if (Array.isArray(payload.availability)) {
          setCalendarSlots(payload.availability);
          setCalendarError(null);
        }
      } catch {
        setCalendarError("Calendar stream parse error.");
      }
    });
    logStream.addEventListener("error", () => {
      setLogsError("Realtime stream disconnected. Retrying...");
    });

    return () => {
      logStream.close();
      if (runStreamRef.current) {
        runStreamRef.current.close();
        runStreamRef.current = null;
      }
    };
  }, []);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;
    const messageText = input.trim();
    const extractedId = extractPatientId(messageText);
    if (extractedId) setPatientId(extractedId);

    const userMessage: Message = { 
      role: "user", 
      text: messageText, 
      timestamp: new Date().toLocaleTimeString() 
    };
    
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);
    setActiveAgent("ORCHESTRATOR");
    setActiveTab("ORCHESTRATOR");

    try {
      if (runStreamRef.current) {
        runStreamRef.current.close();
        runStreamRef.current = null;
      }

      const orchestrateRes = await fetch("/api/orchestrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageText,
          patient_id: extractedId || patientId || undefined
        })
      });

      const orchestrateData = await orchestrateRes.json().catch(() => ({}));
      if (!orchestrateRes.ok || !orchestrateData.run_id) {
        throw new Error(orchestrateData.error || `Failed to start orchestration (${orchestrateRes.status})`);
      }

      const runStream = new EventSource(`/api/stream/runs/${orchestrateData.run_id}`);
      runStreamRef.current = runStream;

      runStream.addEventListener("run_event", (event) => {
        try {
          const payload = JSON.parse((event as MessageEvent).data) as any;
          const agent = payload.agent as Persona | undefined;
          if (agent) {
            setActiveAgent(agent);
          }

          const data = payload.data || {};
          if (data.patient_id) setPatientId(String(data.patient_id));
          if (data.patient_history) setPatientHistory(data.patient_history);

          if (payload.type === "completed") {
            const modelText = data.final_text || "Orchestration completed.";
            setMessages((prev) => [...prev, {
              role: "model",
              text: modelText,
              isCritical: !!data.is_critical,
              timestamp: new Date().toLocaleTimeString()
            }]);
            setIsLoading(false);
            setActiveAgent("ORCHESTRATOR");
            runStream.close();
            runStreamRef.current = null;
          }

          if (payload.type === "error") {
            const errText = data.error || "Orchestration failed.";
            setMessages((prev) => [...prev, {
              role: "model",
              text: `ORCHESTRATION ERROR: ${errText}`,
              timestamp: new Date().toLocaleTimeString()
            }]);
            setIsLoading(false);
            setActiveAgent("ORCHESTRATOR");
            runStream.close();
            runStreamRef.current = null;
          }
        } catch {
          setMessages((prev) => [...prev, {
            role: "model",
            text: "ORCHESTRATION ERROR: Invalid run event payload.",
            timestamp: new Date().toLocaleTimeString()
          }]);
          setIsLoading(false);
          setActiveAgent("ORCHESTRATOR");
          runStream.close();
          runStreamRef.current = null;
        }
      });

      runStream.addEventListener("error", () => {
        if (runStream.readyState === EventSource.CLOSED && isLoading) {
          setMessages((prev) => [...prev, {
            role: "model",
            text: "ORCHESTRATION ERROR: Run stream disconnected.",
            timestamp: new Date().toLocaleTimeString()
          }]);
          setIsLoading(false);
          setActiveAgent("ORCHESTRATOR");
        }
      });
    } catch (error: any) {
      const errorMessage = `ORCHESTRATION ERROR: ${error.message || "Unable to process orchestration."}`;
      
      setMessages((prev) => [...prev, { 
        role: "model", 
        text: errorMessage,
        timestamp: new Date().toLocaleTimeString()
      }]);
      setIsLoading(false);
      setActiveAgent("ORCHESTRATOR");
      if (runStreamRef.current) {
        runStreamRef.current.close();
        runStreamRef.current = null;
      }
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
    },
    PITCH_DECK: {
      title: "Deck",
      icon: <Cpu className="w-5 h-5" />,
      responsibilities: [
        "Executive summary of the VitalFlow engine",
        "Architectural deep-dive and technology stack",
        "Multi-agent methodology and USP",
        "Real-time capability demonstration"
      ],
      color: "bg-purple-600"
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
              <AgentNode label="Deck" active={activeTab === "PITCH_DECK"} color="bg-purple-600" />
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

        {/* Persona Responsibilities Header */}
        {activeTab !== "PITCH_DECK" && (
          <div className="p-4 sm:p-6 bg-white border-b border-slate-200">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold flex items-center gap-2">
                  {personaDetails[activeTab].icon}
                  {personaDetails[activeTab].title}
                </h2>
                <p className="text-[10px] text-slate-400 uppercase tracking-widest mt-0.5">Active Protocol & Responsibilities</p>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href="/docs"
                  target="_blank"
                  rel="noreferrer"
                  className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-widest border border-slate-300 text-slate-600 hover:bg-slate-100 transition-colors"
                >
                  API Docs
                </a>
                <div className={`px-3 py-1 rounded-full text-[10px] font-bold text-white uppercase tracking-widest ${personaDetails[activeTab].color}`}>
                  {activeTab === activeAgent ? "Processing" : "Standby"}
                </div>
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
        )}

        {activeTab === "ORCHESTRATOR" && (
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
        )}

        {activeTab === "CLINICAL_ANALYST" && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            <ContextCard
              title="Patient History"
              icon={<User className="w-4 h-4" />}
              mcp="ALLOYDB"
              content={patientHistory ? (
                <div className="text-sm space-y-2">
                  <div><span className="text-slate-500">Surgery:</span> {patientHistory.surgery}</div>
                  <div><span className="text-slate-500">Date:</span> {patientHistory.date}</div>
                  <div><span className="text-slate-500">Complications:</span> {patientHistory.complications}</div>
                </div>
              ) : null}
            />

          </div>
        )}

        {activeTab === "LOGISTICS_OFFICER" && (
          <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
            <ContextCard
              title="Calendar Availability"
              icon={<Calendar className="w-4 h-4" />}
              mcp="CALENDAR"
              content={calendarSlots.length > 0 ? (
                <div className="space-y-2">
                  {calendarSlots.map((slot, i) => (
                    <div key={i} className="text-xs p-2 bg-blue-50 border border-blue-100 rounded">{slot}</div>
                  ))}
                </div>
              ) : null}
            />
            <ContextCard
              title="Recent Task Writes"
              icon={<ClipboardList className="w-4 h-4" />}
              mcp="AUDIT"
              content={logs.length > 0 ? (
                <div className="space-y-2">
                  {logs.slice(0, 6).map((log) => (
                    <div key={log.id} className="text-xs p-3 bg-white border border-slate-200 rounded flex flex-col gap-1">
                      <div className="flex justify-between items-start">
                        <span className="font-semibold text-slate-700">{log.action}</span>
                        <span className="text-[9px] text-slate-400 font-mono">{new Date(log.created_at).toLocaleString()}</span>
                      </div>
                      <div className="text-slate-500">{log.details}</div>
                      <div className="mt-1 flex items-center justify-between">
                        <span className="text-[9px] font-bold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded uppercase">Patient: {log.patient_id}</span>
                        <span className="text-[9px] font-bold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded">{log.status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ) : null}
            />
          </div>
        )}

        {activeTab === "PITCH_DECK" && (
          <PresentationView logs={logs} systemStatus={systemStatus} onEndPitch={() => setActiveTab("ORCHESTRATOR")} />
        )}

        {/* Input Area */}
        {activeTab === "ORCHESTRATOR" && (
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
            <QuickAction label="Log Symptom" onClick={() => setInput("I have a slight fever. My Patient ID is ...")} />
            <QuickAction label="Recall History" onClick={() => setInput("What symptoms did I report earlier?")} />
          </div>
          <div className="mt-3 text-[10px] text-slate-500">
            Example demo commands:
            <div className="mt-2 flex flex-wrap gap-2">
              <QuickAction
                label="Complex Recall+Plan"
                onClick={() =>
                  setInput(
                    "Patient 101: I had fever and swelling yesterday. Recall my previous history and arrange follow-up."
                  )
                }
              />
              <QuickAction
                label="Escalate & Book"
                onClick={() =>
                  setInput(
                    "Patient 102: pain increased today. Check history, evaluate concern, and book earliest follow-up."
                  )
                }
              />
              <QuickAction
                label="Add Patient Record"
                onClick={() =>
                  setInput(
                    "Add patient 120 surgery: Hernia Repair date:2026-04-08 complications: Mild soreness"
                  )
                }
              />
            </div>
          </div>
        </div>
        )}
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
                      <span className="text-[9px] text-slate-700 bg-slate-100 border border-slate-200 px-2 py-0.5 rounded font-mono">
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="text-xs text-gray-600 leading-relaxed mb-3">{log.details}</p>
                    <div className="flex items-center justify-between">
                      <span className={`text-[9px] px-2 py-0.5 rounded-full font-bold ${
                        log.status === "NORMAL" ? "bg-green-50 text-green-600" : "bg-red-50 text-red-600"
                      }`}>
                        {log.status}
                      </span>
                      <span className="text-[9px] text-blue-700 bg-blue-50 border border-blue-200 px-2 py-0.5 rounded font-mono">
                        PID: {log.patient_id}
                      </span>
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
