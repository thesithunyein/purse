import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { config } from "./config.js";
import { Ledger } from "./ledger.js";
import { Run } from "./agent.js";

const here = dirname(fileURLToPath(import.meta.url));
const ledger = new Ledger(config.users);
const runs = new Map<string, Run>();

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(join(here, "..", "public")));

app.get("/api/state", (_req, res) => {
  res.json({
    mock: config.mock,
    loopModel: config.loopModel,
    settleModel: config.settleModel,
    mcpServers: config.mcpServers.map((server) => ({ name: server.name, url: server.url })),
    accounts: ledger.list().map((account) => ({
      id: account.id,
      label: account.label,
      hasKey: account.apiKey.length > 0,
      bondUsd: account.bondUsd,
      remainingUsd: ledger.remaining(account.id),
      spentUsd: account.spentUsd,
      slashes: account.slashes,
    })),
    runs: [...runs.values()].slice(-10).reverse().map((run) => run.outcome),
  });
});

app.post("/api/run", (req, res) => {
  const body = req.body as { user?: unknown; task?: unknown };
  const user = typeof body.user === "string" ? body.user : "";
  const task = typeof body.task === "string" ? body.task.trim() : "";

  if (!user || !task) {
    res.status(400).json({ error: "user and task are required" });
    return;
  }
  if (task.length > 2000) {
    res.status(400).json({ error: "task is too long" });
    return;
  }
  try {
    ledger.get(user);
  } catch {
    res.status(400).json({ error: `unknown user ${user}` });
    return;
  }

  const run = new Run(user, task, ledger);
  runs.set(run.runId, run);
  res.status(201).json({ runId: run.runId });

  void run.execute();
});

app.get("/api/stream/:runId", (req, res) => {
  const run = runs.get(req.params.runId);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const send = (payload: unknown) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  for (const event of run.events) send({ type: "event", event });
  if (run.outcome.verdict !== "running") {
    send({ type: "done", outcome: run.outcome });
    res.end();
    return;
  }

  const unsubscribe = run.subscribe((event) => send({ type: "event", event }));

  const interval = setInterval(() => {
    if (run.outcome.verdict === "running") {
      res.write(": keepalive\n\n");
      return;
    }
    send({ type: "done", outcome: run.outcome });
    clearInterval(interval);
    unsubscribe();
    res.end();
  }, 1000);

  req.on("close", () => {
    clearInterval(interval);
    unsubscribe();
  });
});

app.post("/api/bond", (req, res) => {
  const body = req.body as { user?: unknown; bondUsd?: unknown };
  const user = typeof body.user === "string" ? body.user : "";
  const bondUsd = typeof body.bondUsd === "number" ? body.bondUsd : Number.NaN;
  if (!user || !Number.isFinite(bondUsd) || bondUsd < 0) {
    res.status(400).json({ error: "user and a non negative bondUsd are required" });
    return;
  }
  try {
    ledger.setBond(user, bondUsd);
  } catch {
    res.status(400).json({ error: `unknown user ${user}` });
    return;
  }
  res.json({ ok: true });
});

app.post("/api/reset", (_req, res) => {
  ledger.reset();
  res.json({ ok: true });
});

app.listen(config.port, () => {
  console.log(`purse on http://localhost:${config.port}`);
  if (config.mock) console.log("PURSE_MOCK=1, every model call is simulated");
  if (config.loopModel === config.settleModel) {
    console.warn("loop and settle models are the same id, set PURSE_SETTLE_MODEL to a second open-weight model");
  }
});
