export type AgentHandle = "shade" | "smoke" | "nav";

export type OpenClawToolEnvelope = {
  ok?: boolean;
  errorCode?: string;
  errorMessage?: string;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    details?: unknown;
  };
};

export type OpenClawSessionsHistoryResult = {
  sessionKey: string;
  messages: Array<{
    role: string;
    timestamp?: number;
    content?: Array<{ type: string; text?: string }>;
  }>;
};
