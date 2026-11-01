export type Role = "system" | "user" | "assistant";

export type Msg = {
  role: Role;
  content: string;
};

export type ToolType = "otari_web_search" | "otari_web_fetch" | "otari_code_execution";

export type ChatRequest = {
  apiKey: string;
  model: string;
  messages: Msg[];
  tools?: ToolType[];
  mcpServerIds?: string[];
  maxTokens?: number;
};

export type ChatResult = {
  id: string;
  requestedModel: string;
  servedModel: string;
  text: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
};

export type Stage = "guard" | "plan" | "research" | "verify" | "settle" | "ledger";

export type LogStatus = "start" | "ok" | "info" | "refused" | "error";

export type LogEvent = {
  seq: number;
  at: string;
  stage: Stage;
  status: LogStatus;
  requestedModel?: string;
  servedModel?: string;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  remainingUsd?: number;
  tools?: string[];
  note?: string;
};

export type RunOutcome = {
  runId: string;
  user: string;
  task: string;
  startedAt: string;
  endedAt?: string;
  verdict: "released" | "slashed" | "stopped" | "running";
  reason?: string;
  bondUsd: number;
  spentUsd: number;
  remainingUsd: number;
};
