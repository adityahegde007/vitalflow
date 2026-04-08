import React from "react";

export const StatusItem: React.FC<{ icon: React.ReactNode, label: string, status: string, subtext?: string, dark?: boolean }> = ({ icon, label, status, subtext, dark }) => (
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
