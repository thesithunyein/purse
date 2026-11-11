import type { ChatRequest, ChatResult, GuardrailVerdict } from "./types.js";

export class OtariError extends Error {
  status: number;
  detail: string;
  // Stable refusal code: the Otari-Error-Code header, or `code` in the body.
  // budget_exceeded and guardrail_violation are the two Purse acts on.
  code?: string;
  budgetScope?: string;
  guardrails?: Array<{ profile: string; score?: number | null }>;
  // True when the body was not gateway JSON: an HTML page from the edge in
  // front of Otari, usually a timeout. Only these are worth one retry.
  edge: boolean;

  constructor(
    status: number,
    detail: string,
    extra: {
      code?: string;
      budgetScope?: string;
      guardrails?: Array<{ profile: string; score?: number | null }>;
      edge?: boolean;
    } = {},
  ) {
    super(`Otari ${status}: ${detail}`);
    this.name = "OtariError";
    this.status = status;
    this.detail = detail;
    this.code = extra.code;
    this.budgetScope = extra.budgetScope;
    this.guardrails = extra.guardrails;
    this.edge = extra.edge ?? false;
  }
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const candidate = block as { type?: string; text?: string };
      if (candidate.type === "text" && typeof candidate.text === "string") {
        parts.push(candidate.text);
      }
    }
  }
  return parts.join("\n").trim();
}

// The gateway bills cost_usd as a decimal string, so Number() it rather than
// trusting the JSON type. A miss here means the ledger silently charges zero.
export function costFromUsage(usage: unknown): number {
  const record = (usage ?? {}) as { cost_usd?: unknown };
  const raw = record.cost_usd;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function countToolCalls(payload: Record<string, unknown>): number {
  const direct = payload.otari_tool_calls;
  if (Array.isArray(direct)) return direct.length;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return 0;
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } }).message;
  return Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
}

// `Otari-Guardrails` is a JSON array, one entry per check that applied.
export function parseGuardrailsHeader(raw: string | null): GuardrailVerdict[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
      .map((entry) => ({
        profile: String(entry.profile ?? "unknown"),
        mode: typeof entry.mode === "string" ? entry.mode : undefined,
        valid: typeof entry.valid === "boolean" ? entry.valid : null,
        score: typeof entry.score === "number" ? entry.score : null,
        status:
          entry.status === "evaluated" || entry.status === "inconclusive" || entry.status === "unavailable"
            ? entry.status
            : undefined,
        reason: typeof entry.reason === "string" ? entry.reason : undefined,
      }));
  } catch {
    return [];
  }
}

// Turn a refused response into an OtariError. The edge can answer with an HTML
// page rather than gateway JSON, so the fallback detail is flattened and short.
export function errorFromResponse(status: number, statusText: string, headers: Headers, raw: string): OtariError {
  let detail = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  let code = headers.get("otari-error-code") ?? undefined;
  let guardrails: Array<{ profile: string; score?: number | null }> | undefined;
  let edge = false;
  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; code?: unknown };
    if (typeof parsed.code === "string") code ??= parsed.code;
    if (typeof parsed.detail === "string") {
      detail = parsed.detail;
    } else if (parsed.detail && typeof parsed.detail === "object") {
      // A guardrail refusal nests its own message, code and flagged checks.
      const nested = parsed.detail as { message?: unknown; code?: unknown; guardrails?: unknown };
      if (typeof nested.message === "string") detail = nested.message;
      if (typeof nested.code === "string") code ??= nested.code;
      if (Array.isArray(nested.guardrails)) {
        guardrails = nested.guardrails
          .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
          .map((entry) => ({
            profile: String(entry.profile ?? "unknown"),
            score: typeof entry.score === "number" ? entry.score : null,
          }));
      }
    }
  } catch {
    // Not gateway JSON: leave the flattened body in place.
    edge = true;
  }
  return new OtariError(status, detail || statusText, {
    edge,
    code,
    budgetScope: headers.get("otari-budget-scope") ?? undefined,
    guardrails,
  });
}

export async function otariChat(req: ChatRequest, baseUrl: string, mock: boolean): Promise<ChatResult> {
  if (mock) return mockChat(req);

  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.messages,
  };
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((type) => ({ type }));
  }
  if (req.mcpServers && req.mcpServers.length > 0) {
    body.mcp_servers = req.mcpServers.map((server) => ({
      name: server.name,
      url: server.url,
      ...(server.purposeHint ? { purpose_hint: server.purposeHint } : {}),
    }));
  }
  if (req.maxTokens !== undefined) {
    body.max_tokens = req.maxTokens;
  }
  if (req.guardrails && req.guardrails.length > 0) {
    body.guardrails = req.guardrails;
  }
  if (req.endUser) {
    body.user = req.endUser;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Otari-Key": req.apiKey,
  };
  if (req.endUser && req.endUserBudget) {
    headers["Otari-End-User-Budget"] = req.endUserBudget;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const raw = await response.text();

  if (!response.ok) {
    throw errorFromResponse(response.status, response.statusText, response.headers, raw);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new OtariError(response.status, "response was not JSON");
  }

  const choices = payload.choices;
  const first = Array.isArray(choices) ? (choices[0] as { message?: { content?: unknown } }) : undefined;
  const usage = (payload.usage ?? {}) as {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  const attempts = Number(response.headers.get("otari-attempt-count") ?? "1");

  return {
    id: String(payload.id ?? ""),
    requestedModel: req.model,
    servedModel: response.headers.get("otari-model") ?? String(payload.model ?? req.model),
    provider: response.headers.get("otari-provider") ?? undefined,
    fallback: response.headers.get("otari-fallback") === "true",
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 1,
    text: textFromContent(first?.message?.content),
    costUsd: costFromUsage(payload.usage),
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    toolCalls: countToolCalls(payload),
    guardrails: parseGuardrailsHeader(response.headers.get("otari-guardrails")),
    endUserBudget: response.headers.get("otari-end-user-budget") ?? undefined,
  };
}

// Local development only. The UI banners every run that used this path.
// It mimics the gateway closely enough to walk all three endings offline:
// a block guardrail flags an obvious injection, and settle answers in the
// same JSON shape the real settle model is asked for.
const MOCK_INJECTION = /ignore\s+(all\s+)?(previous|prior)\s+(instructions|rules)|disregard\s+the\s+(above|rules)/i;

function mockChat(req: ChatRequest): Promise<ChatResult> {
  const last = req.messages[req.messages.length - 1]?.content ?? "";
  const blocking = req.guardrails?.find((entry) => entry.mode === "block");
  const flagged = MOCK_INJECTION.test(last);

  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (blocking && flagged) {
        reject(
          new OtariError(403, "Request blocked by guardrail policy.", {
            code: "guardrail_violation",
            guardrails: [{ profile: blocking.profile, score: 0.99 }],
          }),
        );
        return;
      }
      const stage = req.tools?.length ? req.tools[0] : "plain";
      const text = last.includes("settle this run")
        ? JSON.stringify({
            factsComplete: true,
            reason: "simulated run produced concrete numbers",
            answer: "Test mode answer. A real run shows a short, plain answer here with the number and its source.",
          })
        : `Simulated ${stage} output for ${req.model}.`;
      resolve({
        id: `mock_${Date.now()}`,
        requestedModel: req.model,
        servedModel: req.model,
        fallback: false,
        attempts: 1,
        text,
        costUsd: req.tools?.length ? 0.01 : 0.0002,
        promptTokens: 180,
        completionTokens: 90,
        toolCalls: req.tools?.length ? 1 : 0,
        guardrails: (req.guardrails ?? []).map((entry) => ({
          profile: entry.profile,
          mode: entry.mode,
          valid: !flagged,
          score: flagged ? 0.99 : 0.01,
          status: "evaluated" as const,
        })),
      });
    }, 350);
  });
}

// A free check that a key works before anyone spends on it: list the models
// the key can reach. Nothing is billed for this call.
export async function checkKey(apiKey: string, baseUrl: string): Promise<{ ok: boolean; status: number; detail?: string }> {
  const response = await fetch(`${baseUrl}/models`, { headers: { "Otari-Key": apiKey } });
  if (response.ok) return { ok: true, status: response.status };
  const raw = await response.text();
  return { ok: false, status: response.status, detail: errorFromResponse(response.status, response.statusText, response.headers, raw).detail };
}
