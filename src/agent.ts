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

type Decision = { factsComplete: boolean; reason: string };

function parseDecision(text: string): Decision {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as {
        reason?: unknown;
        factsComplete?: unknown;
      };
      return {
        factsComplete: parsed.factsComplete === true,
        reason: typeof parsed.reason === "string" ? parsed.reason : "no reason given",
      };
    } catch {
      // fall through to the safe default
    }
  }
  return { factsComplete: false, reason: "settlement reply was not parseable" };
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

  async execute(): Promise<RunOutcome> {    try {
      await this.pipeline();
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        this.emit({ stage: "ledger", status: "refused", note: error.message });
        this.finish("stopped", `meter empty: ${error.message}`);
      } else if (error instanceof OtariError) {
        this.emit({ stage: "ledger", status: "error", note: `gateway refused the call: ${error.detail}` });
        this.finish("stopped", error.detail || `gateway error ${error.status}`);
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

    if (policy) {
      this.emit({ stage: "policy", status: "info", note: policy.replace(/\s+/g, " ").slice(0, 180) });
    }

    const plan = await this.stage(
      "plan",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            `Task: ${this.task}`,
            ...(policy ? [`Rule from the rulebook: ${policy}`] : []),
            "Return a plan of at most three steps, one per line, that respects that rule.",
          ].join("\n\n"),
        },
      ],
      undefined,
      "planning with the small model",
      { maxTokens: 300 },
    );

    const research = await this.stage(
      "research",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `Task: ${this.task}\n\nPlan:\n${plan}\n\nSearch for the facts you need, then answer in two lines.\nLine 1: at most two sentences of findings.\nLine 2: start with FACTS: and list the numbers you found with their source.` },
      ],
      ["otari_web_search"],
      "researching with web search",
      { maxTokens: 500 },
    );

    const verified = await this.stage(
      "verify",
      config.loopModel,
      [
        { role: "user", content: `Task: ${this.task}\n\nFacts:\n${research}\n\nUse the code execution tool to compute the arithmetic in this task. Then answer in two lines.\nLine 1: what the code printed.\nLine 2: start with VERIFIED: and give the computed result.` },
      ],
      ["otari_code_execution"],
      "verifying numbers with code execution",
      { maxTokens: 500 },
    );

    const decision = await this.stage(
      "settle",
      config.settleModel,
      [
        { role: "system", content: SYSTEM },
        {
          role: "user",
          content: [
            "You settle this run by answering one question: did the work produce an answer the task can be paid for?",
            `Task: ${this.task}`,
            `Facts gathered: ${research}`,
            `Verification: ${verified}`,
            "factsComplete is true when the facts and the verification together answer the task with concrete numbers, a concrete cost, or a clear yes or no.",
            "It is false only when the run has no usable answer at all.",
            'Answer with JSON only, no prose: {"factsComplete":true|false,"reason":"one sentence"}',
          ].join("\n\n"),
        },
      ],
      undefined,
      "settling with the large model",
      { maxTokens: 300 },
    );

    const parsed = parseDecision(decision);

    this.sync();
    if (!parsed.factsComplete) {
      this.emit({
        stage: "ledger",
        status: "info",
        costUsd: 0,
        remainingUsd: this.ledger.remaining(this.user),
        note: `${parsed.reason.replace(/[.\s]+$/, "")}. nothing was paid out and the bond returns unspent.`,
      });
      this.finish("stopped", parsed.reason);
      return;
    }

    this.emit({
      stage: "ledger",
      status: "ok",
      costUsd: 0,
      remainingUsd: this.ledger.remaining(this.user),
      note: `${parsed.reason.replace(/[.\s]+$/, "")}. unspent bond returned.`,
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
