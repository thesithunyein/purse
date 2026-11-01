// Cheapest possible check that both configured models answer.
// Run: node scripts/check-models.mjs
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

if (!key) {
  console.error("no key in .env");
  process.exit(1);
}

const models = [
  ["loop", env.PURSE_LOOP_MODEL],
  ["settle", env.PURSE_SETTLE_MODEL],
];

for (const [role, model] of models) {
  if (!model) {
    console.log(`SKIP  ${role}  no model configured`);
    continue;
  }
  const started = Date.now();
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Otari-Key": key },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Reply with the single word: ok" }],
        max_tokens: 8,
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        detail = JSON.parse(text).detail ?? detail;
      } catch {}
      console.log(`FAIL  ${role.padEnd(6)} ${model}  ${res.status} ${detail}`);
      continue;
    }
    const json = JSON.parse(text);
    const cost = json.usage?.cost_usd;
    console.log(`PASS  ${role.padEnd(6)} ${model}  served=${json.model} cost=${cost} ${Date.now() - started}ms`);
  } catch (error) {
    console.log(`FAIL  ${role.padEnd(6)} ${model}  ${error.message}`);
  }
}

const distinct = new Set(models.map(([, m]) => m).filter(Boolean));
console.log(distinct.size >= 2 ? "distinct models: yes" : "distinct models: NO, set two different ids");
