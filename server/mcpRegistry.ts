export type McpToolSpec = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
};

export const mcpToolRegistry: McpToolSpec[] = [
  {
    name: "check_calendar",
    description: "Get follow-up appointment availability.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    output_schema: {
      type: "object",
      properties: {
        availability: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "book_followup_appointment",
    description: "Book the earliest or preferred follow-up slot.",
    input_schema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "integer", minimum: 100, maximum: 110 },
        preferred_slot: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        booked_slot: { type: "string" },
        availability: { type: "array", items: { type: "string" } }
      }
    }
  },
  {
    name: "get_recovery_protocol",
    description: "Read recovery protocol notes.",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false
    },
    output_schema: {
      type: "object",
      properties: {
        protocol: { type: "string" }
      }
    }
  },
  {
    name: "get_patient_history",
    description: "Read patient history from DB.",
    input_schema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "integer", minimum: 100, maximum: 110 }
      }
    },
    output_schema: {
      type: "object",
      properties: {
        patient_id: { type: "string" },
        surgery: { type: "string" },
        date: { type: "string" },
        complications: { type: "string" }
      }
    }
  },
  {
    name: "update_patient_history",
    description: "Create/update patient history.",
    input_schema: {
      type: "object",
      required: ["patient_id", "surgery", "date", "complications"],
      properties: {
        patient_id: { type: "integer", minimum: 100, maximum: 110 },
        surgery: { type: "string" },
        date: { type: "string" },
        complications: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        patient_id: { type: "string" }
      }
    }
  },
  {
    name: "get_action_logs",
    description: "Read patient-specific action logs.",
    input_schema: {
      type: "object",
      required: ["patient_id"],
      properties: {
        patient_id: { type: "integer", minimum: 100, maximum: 110 }
      }
    },
    output_schema: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timestamp: { type: "string" },
          action: { type: "string" },
          status: { type: "string" },
          result: { type: "string" }
        }
      }
    }
  },
  {
    name: "update_patient_task",
    description: "Write action/task logs.",
    input_schema: {
      type: "object",
      required: ["patient_id", "task", "status", "details"],
      properties: {
        patient_id: { type: "integer", minimum: 100, maximum: 110 },
        task: { type: "string" },
        status: { type: "string" },
        details: { type: "string" }
      }
    },
    output_schema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        logged: { type: "string" }
      }
    }
  }
];
