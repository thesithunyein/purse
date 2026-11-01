import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = match[2];
    if (key === undefined || raw === undefined) continue;
    if (process.env[key] === undefined) {
      process.env[key] = raw.trim().replace(/^["']|["']$/g, "");
    }
  }
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

const mcpUrl = env("PURSE_MCP_URL", "");

export const config = {
  port: Number(env("PORT", "3000")),
  baseUrl: env("OTARI_BASE_URL", "https://otari.ai/api/v1"),

  // Small open-weight model for the loop, larger one for the call that moves money.
  // Pull real ids from GET /api/v1/models. These two must be different ids.
  loopModel: env("PURSE_LOOP_MODEL", "alibaba/qwen3-30b-a3b-instruct-2507"),
  settleModel: env("PURSE_SETTLE_MODEL", "alibaba/qwen3.6-35b-a3b"),

  // One Otari workspace key per user. Per-user budgets are the point: each key
  // carries its own spend ceiling in the Otari dashboard.
  users: [
    {
      id: "alice",
      label: "Alice",
      apiKey: env("PURSE_KEY_ALICE", ""),
      bondUsd: Number(env("PURSE_BOND_ALICE", "0.20")),
    },
    {
      id: "bob",
      label: "Bob",
      apiKey: env("PURSE_KEY_BOB", ""),
      bondUsd: Number(env("PURSE_BOND_BOB", "0.02")),
    },
  ],

  // Inline MCP server. The gateway connects to this URL on the request itself,
  // so nothing has to be registered in the dashboard first.
  mcpServers: mcpUrl
    ? [
        {
          name: env("PURSE_MCP_NAME", "rulebook"),
          url: mcpUrl,
          purposeHint: env("PURSE_MCP_HINT", "Use for the spending policy this agent must follow"),
        },
      ]
    : [],

  // A live code execution call bills around $0.02, roughly 400x a plain chat
  // call, so each kind of stage reserves its own worst case up front. Without
  // this the agent can spend past a bond it could never have afforded.
  reservePlainUsd: Number(env("PURSE_RESERVE_PLAIN_USD", "0.001")),
  reserveToolUsd: Number(env("PURSE_RESERVE_TOOL_USD", "0.03")),

  mock: env("PURSE_MOCK", "0") === "1",
};
