export type Role = "system" | "user" | "assistant";

export type Msg = {
  role: Role;
  content: string;
};

export type ToolType = "otari_web_search" | "otari_web_fetch" | "otari_code_execution";

export type McpServer = {
  name: string;
  url: string;
  purposeHint?: string;
};

// One entry of the request-level `guardrails` field. Otari runs it on the
// request's input before the provider is called.
export type GuardrailRequest = {
  profile: string;
  mode: "monitor" | "block";
  on_unavailable?: "monitor" | "block";
};

// One entry of the `Otari-Guardrails` response header.
export type GuardrailVerdict = {
  profile: string;
  mode?: string;
  valid: boolean | null;
  score?: number | null;
  status?: "evaluated" | "inconclusive" | "unavailable";
  reason?: string;
};

export type ChatRequest = {
  apiKey: string;
  model: string;
  messages: Msg[];
  tools?: ToolType[];
  mcpServers?: McpServer[];
  maxTokens?: number;
  guardrails?: GuardrailRequest[];
  // Service-key mode: the end user Otari bills, and the budget it starts on.
  endUser?: string;
  endUserBudget?: string;
};

export type ChatResult = {
  id: string;
  requestedModel: string;
  // What actually answered: the Otari-Model header when present. A routing
  // policy keeps its own name in the body's `model`, so the body is not enough.
  servedModel: string;
  provider?: string;
  fallback: boolean;
  attempts: number;
  text: string;
  costUsd: number;
  promptTokens: number;
  completionTokens: number;
  toolCalls: number;
  guardrails: GuardrailVerdict[];
  endUserBudget?: string;
};

export type Stage = "guard" | "policy" | "plan" | "research" | "verify" | "settle" | "ledger";

export type LogStatus = "start" | "ok" | "info" | "refused" | "error";

export type LogEvent = {
  seq: number;
  at: string;
  stage: Stage;
  status: LogStatus;
  requestedModel?: string;
  servedModel?: string;
  provider?: string;
  fallback?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  costUsd?: number;
  estimated?: boolean;
  remainingUsd?: number;
  tools?: string[];
  guardrails?: GuardrailVerdict[];
  note?: string;
};

export type RunOutcome = {
  runId: string;
  user: string;
  task: string;
  startedAt: string;
  endedAt?: string;
  verdict: "released" | "slashed" | "stopped" | "running";
  // Who ended the run: Purse's own ledger, or a gate inside Otari.
  endedBy?: "purse_guard" | "purse_reserve" | "otari_budget" | "otari_guardrail" | "settlement" | "error";
  reason?: string;
  // What the agent found, shown to the person who asked.
  answer?: string;
  bondUsd: number;
  spentUsd: number;
  remainingUsd: number;
};
