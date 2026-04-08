import React from "react";

export const QuickAction: React.FC<{ label: string, onClick: () => void }> = ({ label, onClick }) => (
  <button 
    onClick={onClick}
    className="text-[10px] font-bold uppercase tracking-wider border border-gray-200 px-3 py-1.5 rounded-lg hover:border-blue-500 hover:text-blue-600 hover:bg-blue-50 transition-all bg-white shadow-sm"
  >
    {label}
  </button>
);
