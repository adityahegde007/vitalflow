import React from "react";
import { Zap } from "lucide-react";

export const AgentNode: React.FC<{ label: string, active: boolean, color: string }> = ({ label, active, color }) => (
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
