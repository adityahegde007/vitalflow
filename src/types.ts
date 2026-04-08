export interface Message {
  role: "user" | "model";
  text: string;
  isCritical?: boolean;
  timestamp: string;
}

export interface ActionLog {
  id: number;
  patient_id: string;
  action: string;
  status: string;
  details: string;
  created_at: string;
}

export type Persona = "ORCHESTRATOR" | "CLINICAL_ANALYST" | "LOGISTICS_OFFICER" | "PITCH_DECK";
