import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { BudgetExhausted, Ledger } from "./ledger.js";
import { OtariError, otariChat } from "./otari.js";
import type { ChatResult, GuardrailRequest, LogEvent, Msg, RunOutcome, Stage, ToolType } from "./types.js";

export const GUARD_RULES = [
  { id: "transfer_all", test: /transfer\s+all\s+(funds|balance)/i, note: "asked to transfer the whole balance" },
  { id: "seed_phrase", test: /\b(seed|mnemonic|recovery)\s+phrase\b/i, note: "asked for a seed phrase" },
  {
    // A bare ###-##-#### also matches part numbers and dates, so the number
    // only counts when the text calls it an identity number.
    id: "national_id",
    test: /\b(ssn|social\s+security(\s+number)?|national\s+id(\s+number)?)\b\D{0,20}\d{3}-?\d{2}-?\d{4}\b/i,
    note: "contains what looks like a national id number",
  },
  { id: "override", test: /ignore\s+(all\s+)?(previous|prior)\s+(instructions|rules)/i, note: "tried to override its operating rules" },
];

const SYSTEM = [
  "You are Purse, an agent that pays for its own inference from a bond it holds.",
  "You do the work you were hired for using as little thinking as possible.",
  "Never invent chain state, prices, or transaction hashes. If you need a number, use a tool.",
].join(" ");

export type Decision = { factsComplete: boolean; reason: string };

function decisionFrom(value: unknown): Decision | null {
  if (!value || typeof value !== "object" || !("factsComplete" in value)) return null;
  const record = value as { factsComplete?: unknown; reason?: unknown };
  return {
    factsComplete: record.factsComplete === true,
    reason: typeof record.reason === "string" && record.reason.trim() ? record.reason : "no reason given",
  };
}

// The settle model is asked for JSON only, but models wrap it in code fences or
// add a sentence. Try the whole reply, then each flat {...} that names
// factsComplete. Anything else settles as "no usable answer", never as a payout.
export function parseDecision(text: string): Decision {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  try {
    const whole = decisionFrom(JSON.parse(stripped));
    if (whole) return whole;
  } catch {
    // not a bare JSON object, look inside it
  }
  for (const match of stripped.matchAll(/\{[^{}]*"factsComplete"[^{}]*\}/g)) {
    try {
      const found = decisionFrom(JSON.parse(match[0]));
      if (found) return found;
    } catch {
      // try the next candidate
    }
  }
  return { factsComplete: false, reason: "settlement reply was not parseable" };
}

const money = (value: number) => `$${value.toFixed(6)}`;

export class Run {
  readonly runId = randomUUID().slice(0, 8);
  readonly startedAt = new Date().toISOString();
  readonly user: string;
  readonly task: string;
  readonly events: LogEvent[] = [];
  readonly outcome: RunOutcome;

  private seq = 0;
  private listeners: Array<(event: LogEvent) => void> = [];
  private warnedUnavailable = new Set<string>();

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

  private guardrails(): GuardrailRequest[] | undefined {
    if (!config.guardrailProfile) return undefined;
    return [{ profile: config.guardrailProfile, mode: "block", on_unavailable: config.guardrailOnUnavailable }];
  }

  private reserve(stage: Stage, model: string, tools: ToolType[] | undefined, amount: number): void {
    try {
      this.ledger.requireReserve(this.user, amount);
    } catch (error) {
      if (error instanceof BudgetExhausted) {
        this.emit({ stage, status: "refused", requestedModel: model, tools, note: error.message });
      }
      throw error;
    }
  }

  private async stage(
    stage: Stage,
    model: string,
    messages: Msg[],
    tools: ToolType[] | undefined,
    note: string,
    extra?: { maxTokens?: number; useMcp?: boolean },
  ): Promise<string> {
    const account = this.ledger.get(this.user);
    const apiKey = account.apiKey;
    if (!apiKey && !config.mock) throw new Error(`no Otari key configured for ${this.user}`);

    const mcpServers = extra?.useMcp ? config.mcpServers : undefined;
    const reservedToolCall = (tools?.length ?? 0) > 0 || (mcpServers?.length ?? 0) > 0;
    const reserveUsd = reservedToolCall ? config.reserveToolUsd : config.reservePlainUsd;

    this.reserve(stage, model, tools, reserveUsd);
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
          guardrails: this.guardrails(),
          endUser: config.serviceKeyMode ? `${config.endUserPrefix}${this.user}` : undefined,
          endUserBudget: config.serviceKeyMode && account.endUserBudget ? account.endUserBudget : undefined,
        },
        config.baseUrl,
        config.mock,
      );

    let result: ChatResult;
    try {
      result = await call();
    } catch (error) {
      // A tool loop that outruns the edge timeout comes back as an HTML 502 or
      // 504. Otari may still have run, and billed, the call behind it, and the
      // edge page carries no cost. So the lost attempt is booked at its reserve,
      // the worst case this stage was allowed to spend, and marked as an
      // estimate. Under-counting would let the agent spend past its bond.
      if (error instanceof OtariError && error.edge && (error.status === 502 || error.status === 504)) {
        const estimate = Math.min(reserveUsd, this.ledger.remaining(this.user));
        const remaining = this.ledger.debit(this.user, estimate);
        this.sync();
        this.emit({
          stage,
          status: "info",
          costUsd: estimate,
          estimated: true,
          remainingUsd: remaining,
          note: `edge returned ${error.status} with no receipt, booked the reserve as an estimate and retrying once`,
        });
        this.reserve(stage, model, tools, reserveUsd);
        result = await call();
      } else {
        throw error;
      }
    }

    const remaining = this.ledger.debit(this.user, result.costUsd);
    this.sync();

    const notes = [note];
    if (result.fallback) {
      notes.push(
        `routing fallback: ${result.provider ? `${result.provider}/` : ""}${result.servedModel} answered after ${result.attempts} attempt${result.attempts === 1 ? "" : "s"}`,
      );
    }
    for (const verdict of result.guardrails) {
      if (verdict.status === "unavailable" && !this.warnedUnavailable.has(verdict.profile)) {
        this.warnedUnavailable.add(verdict.profile);
        notes.push(`guardrail ${verdict.profile} could not run (${verdict.reason ?? "unknown"}), served unchecked`);
      } else if (verdict.status === "evaluated") {
        notes.push(`guardrail ${verdict.profile} passed${typeof verdict.score === "number" ? ` (score ${verdict.score.toFixed(2)})` : ""}`);
      }
    }
    if (result.endUserBudget) notes.push(`otari end-user budget ${result.endUserBudget}`);

    this.emit({
      stage,
      status: "ok",
      requestedModel: result.requestedModel,
      servedModel: result.servedModel,
      provider: result.provider,
      fallback: result.fallback,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costUsd: result.costUsd,
      remainingUsd: remaining,
      tools,
      guardrails: result.guardrails.length > 0 ? result.guardrails : undefined,
      note: notes.join(" · "),
    });

    return result.text;
  }

  async execute(): Promise<RunOutcome> {
    try {
      await this.pipeline();
    } catch (error) {
      this.settleError(error);
    }
    return this.outcome;
  }

  private settleError(error: unknown): void {
    if (error instanceof BudgetExhausted) {
      // The refusing stage already logged the refusal; book the ending only.
      this.finish("stopped", `meter empty: ${error.message}`, "purse_reserve");
      return;
    }
    if (error instanceof OtariError && error.code === "guardrail_violation") {
      // Otari refused the call before any provider saw it: a breach caught by
      // the platform, not by the agent's own rulebook. Same consequence.
      const flagged = error.guardrails?.map((entry) => entry.profile).join(", ") || config.guardrailProfile;
      const taken = this.ledger.slash(this.user, this.ledger.remaining(this.user));
      this.sync();
      this.emit({ stage: "guard", status: "refused", note: `otari guardrail ${flagged} blocked the call: ${error.detail}` });
      this.emit({
        stage: "ledger",
        status: "info",
        costUsd: taken,
        remainingUsd: this.ledger.remaining(this.user),
        note: `bond slashed by ${money(taken)} because Otari's guardrail flagged the input`,
      });
      this.finish("slashed", `otari guardrail ${flagged}`, "otari_guardrail");
      return;
    }
    if (error instanceof OtariError && error.code === "budget_exceeded") {
      // Otari's own budget gate refused, before the app meter ran out.
      const scope = error.budgetScope ? ` (scope: ${error.budgetScope})` : "";
      this.emit({ stage: "ledger", status: "refused", note: `otari budget gate refused${scope}: ${error.detail}` });
      this.finish("stopped", `otari budget${scope}: ${error.detail}`, "otari_budget");
      return;
    }
    if (error instanceof OtariError) {
      this.emit({ stage: "ledger", status: "error", note: `gateway refused the call: ${error.detail}` });
      this.finish("stopped", error.detail || `gateway error ${error.status}`, "error");
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.emit({ stage: "ledger", status: "error", note: message });
    this.finish("stopped", message, "error");
  }

  private async pipeline(): Promise<void> {
    this.emit({ stage: "guard", status: "start", note: "checking the task against the operating rules" });

    for (const rule of GUARD_RULES) {
      if (rule.test.test(this.task)) {
        this.emit({ stage: "guard", status: "refused", note: `${rule.id}: ${rule.note}` });
        const taken = this.ledger.slash(this.user, this.ledger.remaining(this.user));
        this.sync();
        this.emit({
          stage: "ledger",
          status: "info",
          costUsd: taken,
          remainingUsd: this.ledger.remaining(this.user),
          note: "bond slashed, nothing was spent on the task itself",
        });
        this.finish("slashed", `rulebook ${rule.id}`, "purse_guard");
        return;
      }
    }

    this.emit({
      stage: "guard",
      status: "ok",
      note: config.guardrailProfile
        ? `no rule matched; Otari guardrail ${config.guardrailProfile} checks every call from here in block mode`
        : "no rule matched",
    });

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

    // Research output is web content. Passing it on as input means Otari's
    // guardrail screens it here, so an injection planted on a page it read
    // is caught before the agent acts on it.
    const verified = await this.stage(
      "verify",
      config.loopModel,
      [
        { role: "system", content: SYSTEM },
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

    this.outcome.answer = [research, verified].map((part) => part.trim()).filter(Boolean).join("\n\n");
    const parsed = parseDecision(decision);
    const reason = parsed.reason.replace(/[.\s]+$/, "");

    this.sync();
    const left = this.ledger.remaining(this.user);
    if (!parsed.factsComplete) {
      this.emit({
        stage: "ledger",
        status: "info",
        costUsd: 0,
        remainingUsd: left,
        note: `${reason}. no payout; inference already billed stays spent, ${money(left)} stays in the bond`,
      });
      this.finish("stopped", parsed.reason, "settlement");
      return;
    }

    this.emit({
      stage: "ledger",
      status: "ok",
      costUsd: 0,
      remainingUsd: left,
      note: `${reason}. released with no penalty, ${money(left)} stays in the bond`,
    });
    this.finish("released", parsed.reason, "settlement");
  }

  private finish(verdict: RunOutcome["verdict"], reason: string, endedBy: RunOutcome["endedBy"]): void {
    this.sync();
    this.outcome.verdict = verdict;
    this.outcome.reason = reason;
    this.outcome.endedBy = endedBy;
    this.outcome.endedAt = new Date().toISOString();
  }
}
