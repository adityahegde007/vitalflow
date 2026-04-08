import React, { useState } from "react";
import { Activity, ClipboardList, Database, Cpu, CheckCircle2, Zap, Clock } from "lucide-react";
import { motion } from "motion/react";
import type { ActionLog } from "../types";

export const PresentationView: React.FC<{ logs: ActionLog[], systemStatus: any, onEndPitch: () => void }> = ({ logs, systemStatus, onEndPitch }) => {
  const [currentSlide, setCurrentSlide] = useState(0);
  
  const slides = [
    {
      title: "VitalFlow: Care Orchestration",
      subtitle: "Closing the gap in post-surgical recovery",
      content: (
        <div className="space-y-6">
          <div className="p-8 rounded-3xl bg-blue-600 text-white shadow-2xl relative overflow-hidden">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <Activity className="w-64 h-64" />
            </div>
            <h3 className="text-3xl font-extrabold mb-4">The Challenge</h3>
            <p className="text-lg opacity-90 leading-relaxed">
              Post-surgical patients often leave the hospital with complex protocols but limited direct supervision. 
              Fragmented communication and unmonitored symptoms lead to preventable re-admissions.
            </p>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-6 rounded-2xl bg-white border border-slate-200">
              <h4 className="font-bold text-blue-600 mb-2">Participant Details</h4>
              <p className="text-sm">Team: <strong>VitalFlow Engineering</strong></p>
              <p className="text-sm">Track: <strong>APAC Gen AI Academy 2026</strong></p>
            </div>
            <div className="p-6 rounded-2xl bg-white border border-slate-200">
              <h4 className="font-bold text-blue-600 mb-2">Problem Statement</h4>
              <p className="text-sm">Scaling specialized clinical monitoring without increasing physician burnout.</p>
            </div>
          </div>
        </div>
      )
    },
    {
      title: "The Multi-Agent Approach",
      subtitle: "Autonomous coordination using Gemini 1.5 Flash",
      content: (
        <div className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="p-6 rounded-2xl bg-blue-50 border border-blue-100">
              <Zap className="w-8 h-8 text-blue-600 mb-3" />
              <h4 className="font-bold mb-2">Orchestrator</h4>
              <p className="text-xs text-slate-600">The central brain managing intent, memory, and safety protocols.</p>
            </div>
            <div className="p-6 rounded-2xl bg-emerald-50 border border-emerald-100">
              <Activity className="w-8 h-8 text-emerald-600 mb-3" />
              <h4 className="font-bold mb-2">Clinical Analyst</h4>
              <p className="text-xs text-slate-600">Queries protocols and history to identify clinical concerns.</p>
            </div>
            <div className="p-6 rounded-2xl bg-amber-50 border border-amber-100">
              <ClipboardList className="w-8 h-8 text-amber-600 mb-3" />
              <h4 className="font-bold mb-2">Logistics Officer</h4>
              <p className="text-xs text-slate-600">Executes actions like appointment booking and task logging.</p>
            </div>
          </div>
          <div className="p-6 rounded-2xl bg-slate-900 text-white font-mono text-xs">
            <p className="text-blue-400 mb-2">// Orchestration Flow:</p>
            <p>1. User Update → Orchestrator</p>
            <p>2. Orchestrator → Analyze(ClinicalAnalyst)</p>
            <p>3. ClinicalAnalyst → Query(AlloyDB + Protocols)</p>
            <p>4. Orchestrator → Act(LogisticsOfficer)</p>
            <p>5. LogisticsOfficer → Book(MCP_Calendar)</p>
          </div>
        </div>
      )
    },
    {
      title: "System Architecture",
      subtitle: "Hybrid persistence with AlloyDB and MCP Tools",
      content: (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl bg-white border border-slate-200">
            <h4 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Database className="w-5 h-5 text-blue-600" />
              Data Persistence Strategy
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="p-4 rounded-xl bg-slate-50">
                <span className="font-bold block mb-1">Production (PostgreSQL)</span>
                Managed AlloyDB for high-concurrency patient audit trails and structured history.
              </div>
              <div className="p-4 rounded-xl bg-slate-50">
                <span className="font-bold block mb-1">Failover (SQLite)</span>
                Automatic edge fallback ensures zero-downtime care orchestration.
              </div>
            </div>
          </div>
          <div className="p-6 rounded-2xl bg-white border border-slate-200">
            <h4 className="font-bold text-slate-800 mb-4 flex items-center gap-2">
              <Cpu className="w-5 h-5 text-purple-600" />
              Technologies Used
            </h4>
            <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
              <span className="px-2 py-1 bg-slate-100 rounded text-blue-600">Gemini 1.5 Flash (Coordination)</span>
              <span className="px-2 py-1 bg-slate-100 rounded text-emerald-600">Gemini 1.5 Pro (Clinical Analysis)</span>
              <span className="px-2 py-1 bg-slate-100 rounded">AlloyDB / PostgreSQL</span>
              <span className="px-2 py-1 bg-slate-100 rounded text-purple-600">Model Context Protocol</span>
              <span className="px-2 py-1 bg-slate-100 rounded">Vite + React</span>
              <span className="px-2 py-1 bg-slate-100 rounded">SSE Streaming</span>
            </div>
          </div>
        </div>
      )
    },
    {
      title: "The Result: Patient Safety",
      subtitle: "Closing the loop with automated vigilance",
      content: (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="p-6 rounded-3xl bg-emerald-600 text-white">
              <CheckCircle2 className="w-12 h-12 mb-4" />
              <h4 className="text-xl font-bold mb-2">Automated Audit</h4>
              <p className="text-sm opacity-90">Every agent thought and tool call is recorded for clinicians to review, ensuring full medical accountability.</p>
            </div>
            <div className="p-6 rounded-3xl bg-blue-600 text-white">
              <Clock className="w-12 h-12 mb-4" />
              <h4 className="text-xl font-bold mb-2">Real-time Response</h4>
              <p className="text-sm opacity-90">SSE pipeline ensures immediate feedback for patients, escalating concerning symptoms to care teams instantly.</p>
            </div>
          </div>
          <div className="p-6 rounded-2xl bg-white border border-slate-200">
            <h4 className="text-sm font-bold text-slate-400 uppercase tracking-widest mb-4">Live System Pulse</h4>
            <div className="flex items-center gap-8 justify-center">
              <div className="text-center">
                <div className="text-2xl font-bold text-blue-600">{logs.length}</div>
                <div className="text-[10px] uppercase text-slate-400">Total Audit Events</div>
              </div>
              <div className="w-px h-8 bg-slate-200"></div>
              <div className="text-center">
                <div className="text-2xl font-bold text-emerald-600">3</div>
                <div className="text-[10px] uppercase text-slate-400">Active Agents</div>
              </div>
              <div className="w-px h-8 bg-slate-200"></div>
              <div className="text-center">
                <div className="text-2xl font-bold text-purple-600">Online</div>
                <div className="text-[10px] uppercase text-slate-400">Database Status</div>
              </div>
            </div>
          </div>
        </div>
      )
    }
  ];

  return (
    <div className="flex-1 flex flex-col items-center p-4 sm:p-8 overflow-y-auto bg-slate-50">
      <div className="max-w-4xl w-full">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-8">
          <div>
            <span className="text-[10px] sm:text-xs font-bold text-purple-600 uppercase tracking-[0.3em]">Gen AI Academy APAC</span>
            <h2 className="text-2xl sm:text-4xl font-extrabold tracking-tight mt-1">{slides[currentSlide].title}</h2>
            <p className="text-slate-400 mt-2 font-medium">{slides[currentSlide].subtitle}</p>
          </div>
          <div className="flex gap-2">
            {slides.map((_, i) => (
              <div key={i} className={`w-3 h-3 rounded-full transition-all ${currentSlide === i ? "bg-purple-600 w-8" : "bg-slate-200"}`}></div>
            ))}
          </div>
        </div>

        <motion.div
          key={currentSlide}
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -20 }}
          transition={{ duration: 0.3 }}
          className="min-h-[400px]"
        >
          {slides[currentSlide].content}
        </motion.div>

        <div className="flex justify-between items-center mt-8 pt-4 border-t border-slate-200">
          <button
            onClick={() => setCurrentSlide(prev => Math.max(0, prev - 1))}
            disabled={currentSlide === 0}
            className="px-6 py-3 text-sm font-bold text-slate-400 hover:text-slate-800 transition-colors disabled:opacity-30 uppercase tracking-widest"
          >
            Previous
          </button>
          <div className="text-xs font-mono text-slate-400">Slide {currentSlide + 1} / {slides.length}</div>
          <button
            onClick={() => {
              if (currentSlide === slides.length - 1) {
                onEndPitch();
              } else {
                setCurrentSlide(prev => Math.min(slides.length - 1, prev + 1));
              }
            }}
            className="px-8 py-3 bg-slate-900 text-white rounded-full font-bold text-sm hover:scale-105 transition-all uppercase tracking-widest shadow-xl"
          >
            {currentSlide === slides.length - 1 ? "End Pitch" : "Next Slide"}
          </button>
        </div>
      </div>
    </div>
  );
};
