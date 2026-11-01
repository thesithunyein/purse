import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { BudgetExhausted, Ledger } from "./ledger.js";
import { OtariError, otariChat } from "./otari.js";
import type { LogEvent, Msg, RunOutcome, Stage, ToolType } from "./types.js";

const GUARD_RULES = [
  { id: "transfer_all", test: /transfer\s+all\s+(funds|balance)/i, note: "asked to transfer the whole balance" },
  { id: "seed_phrase", test: /\b(seed|mnemonic|recovery)\s+phrase\b/i, note: "asked for a seed phrase" },
  { id: "national_id", test: /\b\d{3}-\d{2}-\d{4}\b/i, note: "contains what looks like a national id number" },
  { id: "override", test: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|rules)/i, note: "tried to override its operating rules" },
];

const SYSTEM = [
  "You are Purse, an agent that pays for its own inference from a bond it holds.",
  "You do the work you were hired for using as little thinking as possible.",
  "Never invent chain state, prices, or transaction hashes. If you need a number, use a tool.",
].join(" ");

function parseDecision(text: string): { verdict: "release" | "slash"; reason: string; penaltyUsd: number } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        verdict?: string;
        reason?: string;
        penaltyUsd?: number;
      };
      return {
        verdict: parsed.verdict === "slash" ? "slash" : "release",
        reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
        penaltyUsd: typeof parsed.penaltyUsd === "number" ? parsed.penaltyUsd : 0,
      };
    } catch {
      // fall through to the safe default
    }
  }
  return { verdict: "release", reason: "settlement reply was not parseable", penaltyUsd: 0 };
}

export class Run {
  readonly runId = randomUUID().slice(0, 8);
  readonly startedAt = new Date().toISOString();
  readonly user: string;
  readonly task: string;
  readonly events: LogEvent[] = [];
  readonly outcome: RunOutcome;

  private seq = 0;
  private listeners: Array<(event: LogEvent) => void> = [];

  constructor(user: string, task: string, private ledger: Ledger) {
    this.user = user;
    this.task = task;
    this.outcome = {
      runId: this.runId,
      user,
      task,
      startedAt: this.startedAt,
      verdict: "running",
      bondUsd: ledger.get(user).bondUsd,
      spentUsd: 0,
      remainingUsd: ledger.remaining(user),
    };
  }

  subscribe(listener: (event: LogEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }

  private emit(event: Omit<LogEvent, "seq" | "at">): void {
    const full: LogEvent = { ...event, seq: ++this.seq, at: new Date().toISOString() };
    this.events.push(full);
    for (const listener of this.listeners) listener(full);
  }

  private sync(): void {
    const account = this.ledger.get(this.user);
    this.outcome.spentUsd = account.spentUsd;
    this.outcome.remainingUsd = this.ledger.remaining(this.user);
  }

  private async stage(
    stage: Stage,
    model: string,
    messages: Msg[],
    tools: ToolType[] | undefined,
    note: string,
    extra?: { maxTokens?: number; useMcp?: boolean },
  ): Promise<string> {
    const apiKey = this.ledger.get(this.user).apiKey;
    if (!apiKey && !config.mock) throw new Error(`no Otari key configured for ${this.user}`);

    const mcpServers = extra?.useMcp ? config.mcpServers : undefined;
    const reservedToolCall = (tools?.length ?? 0) > 0 || (mcpServers?.length ?? 0) > 0;
    try {
      this.ledger.requireReserve(this.user, reservedToolCall ? config.reserveToolUsd : config.reservePlainUsd);
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        this.emit({ stage, status: "refused", requestedModel: model, tools, note: error.message });
      }
      throw error;
    }
    this.emit({ stage, status: "start", requestedModel: model, tools, note });

    const call = () =>
      otariChat(
        {
          apiKey,
          model,
          messages,
          tools,
          mcpServers,
          maxTokens: extra?.maxTokens,
        },
        config.baseUrl,
        config.mock,
      );

    let result;
    try {
      result = await call();
    } catch (error) {
      // A tool loop that outruns the edge timeout comes back as 502 or 504 with
      // an HTML page. One retry covers it, and the attempt stays in the log.
      if (error instanceof OtariError && (error.status === 502 || error.status === 504)) {
        this.emit({ stage, status: "info", note: `edge returned ${error.status}, retrying once` });
        result = await call();
      } else {
        throw error;
      }
    }

    const remaining = this.ledger.debit(this.user, result.costUsd);
    this.sync();

    this.emit({
      stage,
      status: "ok",
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      remainingUsd: remaining,
      tools,
      note:
        result.servedModel !== result.requestedModel
          ? `served by ${result.servedModel} instead of ${result.requestedModel}, a fallback took the call`
          : note,
    });

    return result.text;
  }

  async execute(): Promise<RunOutcome> {
    try {
      await this.pipeline();
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        this.emit({ stage: "ledger", status: "refused", note: error.message });
        this.finish("stopped", `meter empty: ${error.message}`);
      } else if (error instanceof OtariError) {
        this.emit({ stage: "ledger", status: "error", note: `gateway refused the call: ${error.detail}` });
        this.finish("stopped", `gateway error ${error.status}`);
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.emit({ stage: "ledger", status: "error", note: message });
        this.finish("stopped", message);
      }
    }
    return this.outcome;
  }

  private async pipeline(): Promise<void> {
    this.emit({ stage: "guard", status: "start", note: "checking the task against the operating rules" });

    for (const rule of GUARD_RULES) {
      if (rule.test.test(this.task)) {
        this.emit({ stage: "guard", status: "refused", note: `${rule.id}: ${rule.note}` });
        const penalty = this.ledger.remaining(this.user);
        this.ledger.slash(this.user, penalty);
        this.sync();
        this.emit({
          stage: "ledger",
          status: "info",
          costUsd: penalty,
          remainingUsd: this.ledger.remaining(this.user),
          note: "bond slashed, nothing was spent on the task itself",
        });
        this.finish("slashed", `guardrail ${rule.id}`);
        return;
      }
    }

    this.emit({ stage: "guard", status: "ok", note: "no rule matched" });

    const policy = config.mcpServers.length > 0
      ? await this.stage(
          "policy",
          config.loopModel,
          [
            { role: "system", content: SYSTEM },
            {
              role: "user",
              content: `Task: ${this.task}\n\nRead the repository spending rules. Reply with the one rule that applies here, in one sentence.`,
            },
          ],
          undefined,
          `reading the rulebook over MCP from ${config.mcpServers[0]?.name}`,
          { maxTokens: 120, useMcp: true },
        )
      : "";

    const plan = await this.stage(
      "plan",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${this.task}\n\nReturn a plan of at most three steps, one per line.` },
      ],
      undefined,
      "planning with the small model",
      { maxTokens: 200 },
    );

    const research = await this.stage(
      "research",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${this.task}\n\nPlan:\n${plan}\n\nGather the facts you need. Cite what you used.` },
      ],
      ["otari_web_search"],
      "researching with web search",
      { maxTokens: 300 },
    );

    const verified = await this.stage(
      "verify",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${this.task}\n\nFacts:\n${research}\n\nCheck any number in the facts by running code. Report what the code returned.` },
      ],
      ["otari_code_execution"],
      "verifying numbers with code execution",
      { maxTokens: 300 },
    );

    const decision = await this.stage(
      "settle",
      config.settleModel,
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            "You make the settlement decision for this run.",
            `Task: ${this.task}`,
            ...(policy ? [`Operating rule: ${policy}`] : []),
            `Facts: ${research}`,
            `Verification: ${verified}`,
            'Reply with JSON only, no prose: {"verdict":"release"|"slash","reason":"one sentence","penaltyUsd":number}',
            "Slash only if the work is wrong or a rule was broken.",
          ].join("\n\n"),
        },
      ],
      undefined,
      "settling with the large model",
      { maxTokens: 200 },
    );

    const parsed = parseDecision(decision);
    if (parsed.verdict === "slash") {
      const remaining = this.ledger.remaining(this.user);
      const penalty = parsed.penaltyUsd > 0 ? parsed.penaltyUsd : remaining;
      this.ledger.slash(this.user, penalty);
      this.sync();
      this.emit({ stage: "ledger", status: "refused", costUsd: penalty, remainingUsd: this.ledger.remaining(this.user), note: parsed.reason });
      this.finish("slashed", parsed.reason);
      return;
    }

    this.sync();
    this.emit({
      stage: "ledger",
      status: "ok",
      costUsd: 0,
      remainingUsd: this.ledger.remaining(this.user),
      note: `${parsed.reason}. unspent bond returned.`,
    });
    this.finish("released", parsed.reason);
  }

  private finish(verdict: RunOutcome["verdict"], reason: string): void {
    this.sync();
    this.outcome.verdict = verdict;
    this.outcome.reason = reason;
    this.outcome.endedAt = new Date().toISOString();
  }
}
