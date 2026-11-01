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

export const config = {
  port: Number(env("PORT", "3000")),
  baseUrl: env("OTARI_BASE_URL", "https://otari.ai/api/v1"),

  // Small open-weight model for the loop, larger one for the call that moves money.
  // Pull real ids from GET /api/v1/models. These two must be different ids.
  loopModel: env("PURSE_LOOP_MODEL", "alibaba/qwen3.6-35b-a3b"),
  settleModel: env("PURSE_SETTLE_MODEL", "alibaba/qwen3.6-35b-a3b"),

  // One Otari workspace key per user. Per-user budgets are the point: each key
  // carries its own spend ceiling in the Otari dashboard.
  users: [
    {
      id: "alice",
      label: "Alice",
      apiKey: env("PURSE_KEY_ALICE", ""),
      bondUsd: Number(env("PURSE_BOND_ALICE", "0.01")),
    },
    {
      id: "bob",
      label: "Bob",
      apiKey: env("PURSE_KEY_BOB", ""),
      bondUsd: Number(env("PURSE_BOND_BOB", "0.01")),
    },
  ],

  // MCP servers are registered in the workspace under Tools -> MCP servers.
  // Comma separated ids. Empty means no MCP stage tool is attached.
  mcpServerIds: env("PURSE_MCP_SERVER_IDS", "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),

  // Reserve required before each model call so the meter runs out predictably
  // instead of mid-request.
  callReserveUsd: Number(env("PURSE_CALL_RESERVE_USD", "0.0005")),

  mock: env("PURSE_MOCK", "0") === "1",
};
