import React from "react";
import { Activity } from "lucide-react";

export const ContextCard: React.FC<{ title: string, icon: React.ReactNode, mcp: string, content: React.ReactNode, emptyMessage?: string }> = ({ title, icon, mcp, content, emptyMessage }) => (
  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
    <div className="px-4 py-3 border-b border-gray-50 flex items-center justify-between bg-gray-50/50">
      <div className="flex items-center gap-2 text-gray-600">
        {icon}
        <span className="text-[10px] font-bold uppercase tracking-widest">{title}</span>
      </div>
      <span className="text-[8px] font-mono text-gray-400">{mcp} MCP</span>
    </div>
    <div className="p-4">
      {content || <p className="text-[10px] text-gray-400 italic flex items-center gap-2 px-3 py-4 bg-gray-50/50 rounded-lg border border-gray-100 border-dashed"><Activity className="w-3 h-3 opacity-50"/>{emptyMessage || "Awaiting context from Orchestrator..."}</p>}
    </div>
  </div>
);
