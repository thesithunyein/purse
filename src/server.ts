import express from "express";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { Ledger } from "./ledger.js";
import { Run } from "./agent.js";
import { checkKey } from "./otari.js";

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

// Shared accounts spend the deploy owner's Otari key, so they can sit behind
// an access code. A visitor's own key needs none: they pay for their runs.
function codeMatches(given: string): boolean {
  const expected = Buffer.from(config.accessCode);
  const actual = Buffer.from(given);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A key the visitor brings is used for that one request and never stored or
// logged. Printable ASCII only, so it cannot smuggle anything into a header.
function ownKey(header: string | undefined): string {
  const key = (header ?? "").trim();
  return key.length >= 8 && key.length <= 256 && /^[\x21-\x7e]+$/.test(key) ? key : "";
}

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
    // Only shared accounts that can actually run are offered.
    accounts: config.users
      .filter((user) => user.apiKey.length > 0 || config.mock)
      .map((user) => ({ id: user.id, label: user.label })),
    accessCode: config.accessCode.length > 0,
  });
});

app.post("/api/key", async (req, res) => {
  const key = ownKey(req.header("x-otari-key"));
  if (!key) {
    res.status(400).json({ ok: false, error: "That doesn't look like a full key. Copy it again." });
    return;
  }
  if (config.mock) {
    res.json({ ok: true });
    return;
  }
  try {
    const result = await checkKey(key, config.baseUrl);
    if (result.ok) {
      res.json({ ok: true });
    } else if (result.status === 401 || result.status === 403) {
      res.status(400).json({ ok: false, error: "Otari didn't accept this key. Check you copied all of it." });
    } else {
      res.status(502).json({ ok: false, error: "Couldn't reach Otari to check the key. Try again in a moment." });
    }
  } catch {
    res.status(502).json({ ok: false, error: "Couldn't reach Otari to check the key. Try again in a moment." });
  }
});

app.post("/api/run", async (req, res) => {
  const body = req.body as { user?: unknown; task?: unknown; budgetUsd?: unknown };
  const task = typeof body.task === "string" ? body.task.trim() : "";
  const budgetUsd = typeof body.budgetUsd === "number" ? body.budgetUsd : Number.NaN;
  const visitorKey = ownKey(req.header("x-otari-key"));

  // Two ways to pay: the visitor's own Otari key, or one of this deploy's
  // shared accounts. Shared accounts spend the owner's money, so they need the
  // access code when one is set.
  let account: { id: string; label: string; apiKey: string; endUserBudget: string } | undefined;
  if (visitorKey) {
    account = { id: "you", label: "Your key", apiKey: visitorKey, endUserBudget: "" };
  } else {
    if (config.accessCode && !codeMatches(req.header("x-purse-code") ?? "")) {
      res.status(401).json({ error: "access code required" });
      return;
    }
    const userId = typeof body.user === "string" ? body.user : "";
    account = config.users.find((user) => user.id === userId && (user.apiKey || config.mock));
  }

  if (!account) {
    res.status(400).json({ error: "Connect your Otari key to run a task." });
    return;
  }
  if (!task) {
    res.status(400).json({ error: "Write a task first." });
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
  const ledger = new Ledger([{ ...account, bondUsd: budgetUsd }]);
  const run = new Run(account.id, task, ledger, { endUsers: !visitorKey && config.serviceKeyMode });

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
    if (!config.accessCode && config.users.some((user) => user.apiKey)) {
      console.log("PURSE_ACCESS_CODE is not set, anyone can spend the shared accounts");
    }
    if (config.loopModel === config.settleModel) {
      console.warn("loop and settle models are the same id, set PURSE_SETTLE_MODEL to a second open-weight model");
    }
  });
}

export default app;
