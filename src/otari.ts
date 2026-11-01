import type { ChatRequest, ChatResult } from "./types.js";

export class OtariError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(`Otari ${status}: ${detail}`);
    this.name = "OtariError";
    this.status = status;
    this.detail = detail;
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

function countToolCalls(payload: Record<string, unknown>): number {
  const direct = payload.otari_tool_calls;
  if (Array.isArray(direct)) return direct.length;
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices.length === 0) return 0;
  const message = (choices[0] as { message?: { tool_calls?: unknown[] } }).message;
  return Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0;
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
  if (req.mcpServerIds && req.mcpServerIds.length > 0) {
    body.mcp_server_ids = req.mcpServerIds;
  }
  if (req.maxTokens !== undefined) {
    body.max_tokens = req.maxTokens;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Otari-Key": req.apiKey,
    },
    body: JSON.stringify(body),
  });

  const raw = await response.text();

  if (!response.ok) {
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { detail?: string };
      if (typeof parsed.detail === "string") detail = parsed.detail;
    } catch {
      // leave raw body in place
    }
    throw new OtariError(response.status, detail || response.statusText);
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
    cost_usd?: number;
  };

  return {
    id: String(payload.id ?? ""),
    requestedModel: req.model,
    servedModel: String(payload.model ?? req.model),
    text: textFromContent(first?.message?.content),
    costUsd: typeof usage.cost_usd === "number" ? usage.cost_usd : 0,
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    toolCalls: countToolCalls(payload),
  };
}

// Local development only. The UI banners every run that used this path.
function mockChat(req: ChatRequest): Promise<ChatResult> {
  const stage = req.tools?.length ? req.tools[0] : "plain";
  const text =
    req.messages[req.messages.length - 1]?.content.includes("settlement")
      ? JSON.stringify({ verdict: "release", reason: "work matches the request", penaltyUsd: 0 })
      : `Simulated ${stage} output for ${req.model}.`;

  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        id: `mock_${Date.now()}`,
        requestedModel: req.model,
        servedModel: req.model,
        text,
        costUsd: 0.0002,
        promptTokens: 180,
        completionTokens: 90,
        toolCalls: req.tools?.length ? 1 : 0,
      });
    }, 350);
  });
}
