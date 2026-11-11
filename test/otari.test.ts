import { test } from "node:test";
import assert from "node:assert/strict";
import { costFromUsage, errorFromResponse, otariChat, parseGuardrailsHeader } from "../src/otari.js";

test("cost_usd is read from a decimal string or a number", () => {
  assert.equal(costFromUsage({ cost_usd: "0.0104" }), 0.0104);
  assert.equal(costFromUsage({ cost_usd: 0.002 }), 0.002);
  assert.equal(costFromUsage({ cost_usd: "abc" }), 0);
  assert.equal(costFromUsage(undefined), 0);
});

test("a guardrail refusal keeps its code and flagged profiles", () => {
  const body = JSON.stringify({
    detail: {
      message: "Request blocked by guardrail policy.",
      code: "guardrail_violation",
      guardrails: [{ profile: "prompt-injection", explanation: null, score: 0.98 }],
    },
  });
  const error = errorFromResponse(403, "Forbidden", new Headers(), body);
  assert.equal(error.code, "guardrail_violation");
  assert.equal(error.detail, "Request blocked by guardrail policy.");
  assert.deepEqual(error.guardrails, [{ profile: "prompt-injection", score: 0.98 }]);
  assert.equal(error.edge, false);
});

test("a budget refusal reads Otari-Error-Code and Otari-Budget-Scope", () => {
  const headers = new Headers({ "Otari-Error-Code": "budget_exceeded", "Otari-Budget-Scope": "user" });
  const error = errorFromResponse(403, "Forbidden", headers, JSON.stringify({ detail: "API key has exceeded budget limit" }));
  assert.equal(error.code, "budget_exceeded");
  assert.equal(error.budgetScope, "user");
  assert.equal(error.detail, "API key has exceeded budget limit");
});

test("an HTML page from the edge is flagged as edge, not gateway", () => {
  const error = errorFromResponse(504, "Gateway Timeout", new Headers(), "<html><body><h1>504 Gateway Timeout</h1></body></html>");
  assert.equal(error.edge, true);
  assert.equal(error.detail, "504 Gateway Timeout");
});

test("the Otari-Guardrails header parses and tolerates junk", () => {
  const parsed = parseGuardrailsHeader(
    '[{"profile":"prompt-injection","mode":"block","valid":null,"score":null,"status":"unavailable","reason":"not_configured"}]',
  );
  assert.equal(parsed[0]?.status, "unavailable");
  assert.equal(parsed[0]?.reason, "not_configured");
  assert.deepEqual(parseGuardrailsHeader("not json"), []);
  assert.deepEqual(parseGuardrailsHeader(null), []);
});

test("otariChat sends guardrails and the end user, and reads routing headers", async (t) => {
  let sent: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
    sent = { headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) };
    return new Response(
      JSON.stringify({
        id: "c1",
        model: "purse-loop",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, cost_usd: "0.00002" },
      }),
      {
        status: 200,
        headers: {
          "Otari-Model": "mistral-small-3.2-24b-instruct-2506",
          "Otari-Provider": "mistral",
          "Otari-Fallback": "true",
          "Otari-Attempt-Count": "2",
          "Otari-Guardrails": '[{"profile":"prompt-injection","mode":"block","valid":true,"score":0.01,"status":"evaluated"}]',
        },
      },
    );
  });

  const result = await otariChat(
    {
      apiKey: "k",
      model: "purse-loop",
      messages: [{ role: "user", content: "hi" }],
      guardrails: [{ profile: "prompt-injection", mode: "block", on_unavailable: "monitor" }],
      endUser: "purse:alice",
      endUserBudget: "budget-1",
    },
    "https://example.test/api/v1",
    false,
  );

  assert.deepEqual(sent?.body.guardrails, [{ profile: "prompt-injection", mode: "block", on_unavailable: "monitor" }]);
  assert.equal(sent?.body.user, "purse:alice");
  assert.equal(sent?.headers["Otari-End-User-Budget"], "budget-1");
  assert.equal(result.servedModel, "mistral-small-3.2-24b-instruct-2506");
  assert.equal(result.provider, "mistral");
  assert.equal(result.fallback, true);
  assert.equal(result.attempts, 2);
  assert.equal(result.costUsd, 0.00002);
  assert.equal(result.guardrails[0]?.valid, true);
});

test("checkKey lists models with the key and reports a refusal", async (t) => {
  const { checkKey } = await import("../src/otari.js");
  let seen = "";
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    seen = `${url} ${(init.headers as Record<string, string>)["Otari-Key"]}`;
    return new Response(JSON.stringify({ detail: "Invalid API key" }), { status: 401 });
  });
  const result = await checkKey("otk_bad", "https://example.test/api/v1");
  assert.equal(seen, "https://example.test/api/v1/models otk_bad");
  assert.deepEqual(result, { ok: false, status: 401, detail: "Invalid API key" });
});
