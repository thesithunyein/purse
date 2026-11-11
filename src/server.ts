import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { Ledger } from "./ledger.js";
import { Run } from "./agent.js";

// Stateless by design: one request runs one task and streams it back. Nothing
// is kept between requests, so it runs the same on a single server and on
// serverless hosts (Vercel), where each request may land on a fresh instance.
// The budget belongs to the run. The account's Otari key, and the budget Otari
// holds for it, are what persist across runs.

const here = dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "64kb" }));
// Local only. Vercel ignores express.static and serves public/ from its CDN.
app.use(express.static(join(here, "..", "public")));

// A public deploy spends real money on a real Otari key, so every API route
// can sit behind a shared access code. Unset means open, for local use.
function codeMatches(given: string): boolean {
  const expected = Buffer.from(config.accessCode);
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

app.use("/api", (req, res, next) => {
  if (!config.accessCode) return next();
  if (codeMatches(req.header("x-purse-code") ?? "")) return next();
  res.status(401).json({ error: "access code required" });
});

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/state", (_req, res) => {
  res.json({
    mock: config.mock,
    loopModel: config.loopModel,
    settleModel: config.settleModel,
    guardrailProfile: config.guardrailProfile || null,
    serviceKeyMode: config.serviceKeyMode,
    maxBudgetUsd: config.maxBudgetUsd,
    defaultBudgetUsd: config.users[0]?.bondUsd ?? 0.2,
    accounts: config.users.map((user) => ({
      id: user.id,
      label: user.label,
      hasKey: user.apiKey.length > 0,
    })),
  });
});

app.post("/api/run", async (req, res) => {
  const body = req.body as { user?: unknown; task?: unknown; budgetUsd?: unknown };
  const userId = typeof body.user === "string" ? body.user : "";
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const budgetUsd = typeof body.budgetUsd === "number" ? body.budgetUsd : Number.NaN;
  const account = config.users.find((user) => user.id === userId);

  if (!account || !task) {
    res.status(400).json({ error: "Pick an account and write a task." });
    return;
  }
  if (task.length > 2000) {
    res.status(400).json({ error: "Keep the task under 2,000 characters." });
    return;
  }
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > config.maxBudgetUsd) {
    res.status(400).json({ error: `Set a budget between $0.01 and $${config.maxBudgetUsd.toFixed(2)}.` });
    return;
  }
  if (!account.apiKey && !config.mock) {
    res.status(400).json({ error: `${account.label} has no Otari key yet.` });
    return;
  }

  const ledger = new Ledger([{ ...account, bondUsd: budgetUsd }]);
  const run = new Run(account.id, task, ledger);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  const unsubscribe = run.subscribe((event) => send({ type: "event", event }));
  const keepalive = setInterval(() => res.write(": keepalive\n\n"), 10_000);
  try {
    const outcome = await run.execute();
    send({ type: "done", outcome });
  } catch (error) {
    // execute() settles its own errors; this only guards the stream itself.
    send({ type: "fail", error: error instanceof Error ? error.message : String(error) });
  } finally {
    clearInterval(keepalive);
    unsubscribe();
    res.end();
  }
});

if (!process.env.VERCEL) {
  app.listen(config.port, () => {
    console.log(`purse on http://localhost:${config.port}`);
    if (config.mock) console.log("PURSE_MOCK=1, every model call is simulated");
    if (!config.accessCode) console.log("PURSE_ACCESS_CODE is not set, the API is open to anyone who can reach this port");
    if (config.loopModel === config.settleModel) {
      console.warn("loop and settle models are the same id, set PURSE_SETTLE_MODEL to a second open-weight model");
    }
  });
}

export default app;
