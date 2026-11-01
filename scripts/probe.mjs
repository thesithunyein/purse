// Live gateway probe. Reads .env, so no secret is ever passed on a command line.
// Run: node scripts/probe.mjs
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const envPath = resolve(process.cwd(), ".env");
  const env = {};
  if (!existsSync(envPath)) return env;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const at = line.indexOf("=");
    if (at <= 0) continue;
    env[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return env;
}

const env = loadEnv();
const base = env.OTARI_BASE_URL || "https://otari.ai/api/v1";
const key = env.PURSE_KEY_ALICE || "";
const keyB = env.PURSE_KEY_BOB || "";

if (!key) {
  console.error("no key in .env, run scripts/set-keys.ps1 first");
  process.exit(1);
}

const results = [];

async function call(label, body, apiKey = key) {
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Otari-Key": apiKey },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 300);
      try {
        detail = JSON.parse(text).detail ?? detail;
      } catch {}
      results.push({ label, ok: false, status: res.status, detail });
      return;
    }
    const json = JSON.parse(text);
    const usage = json.usage ?? {};
    results.push({
      label,
      ok: true,
      status: res.status,
      model: json.model,
      cost: usage.cost_usd,
      toolCalls: Array.isArray(json.otari_tool_calls) ? json.otari_tool_calls.length : 0,
    });
  } catch (error) {
    results.push({ label, ok: false, status: "network", detail: String(error.message || error) });
  }
}

console.log(`base ${base}`);

try {
  const res = await fetch(`${base}/models`, { headers: { "Otari-Key": key } });
  if (res.ok) {
    const data = await res.json();
    const ids = (data.data ?? []).map((m) => m.id);
    console.log(`models: ${ids.length} reachable`);
    const open = ids.filter((id) => /qwen|llama|mistral|deepseek|gpt-oss|glm|phi|gemma/i.test(id));
    console.log("open weight candidates:");
    for (const id of open.slice(0, 40)) console.log(`  ${id}`);
  } else {
    console.log(`models: HTTP ${res.status}`);
  }
} catch (error) {
  console.log(`models: network error ${error.message}`);
}

const model = env.PURSE_LOOP_MODEL || "alibaba/qwen3.6-35b-a3b";

await call("plain chat", {
  model,
  messages: [{ role: "user", content: "Reply with the single word: ok" }],
});

await call("web search tool", {
  model,
  messages: [{ role: "user", content: "What is the current USDC gas cost on Base? One sentence." }],
  tools: [{ type: "otari_web_search" }],
});

await call("code execution tool", {
  model,
  messages: [{ role: "user", content: "Compute 23 factorial using code." }],
  tools: [{ type: "otari_code_execution" }],
});

if (env.PURSE_MCP_SERVER_IDS) {
  const ids = env.PURSE_MCP_SERVER_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  await call("mcp server", {
    model,
    messages: [{ role: "user", content: "List the tools you have available, briefly." }],
    mcp_server_ids: ids,
  });
} else {
  results.push({ label: "mcp server", ok: null, status: "-", detail: "PURSE_MCP_SERVER_IDS is empty" });
}

if (keyB) {
  await call("per user key b", {
    model,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
  }, keyB);
} else {
  results.push({ label: "per user key b", ok: null, status: "-", detail: "second key missing" });
}

console.log("");
for (const r of results) {
  const mark = r.ok === true ? "PASS" : r.ok === false ? "FAIL" : "SKIP";
  const tail = r.ok ? `${r.status} model=${r.model} cost=${r.cost} tools=${r.toolCalls}` : (r.detail ?? "");
  console.log(`${mark}  ${r.label.padEnd(20)} ${tail}`);
}

const failed = results.filter((r) => r.ok === false).length;
process.exit(failed > 0 ? 1 : 0);
