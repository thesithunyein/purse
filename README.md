# Purse

An agent that can only act while it can pay for its own thinking.

Every model call is metered against a bond the agent posts up front. When the
meter runs out the run stops and the unspent bond comes back. When the agent
breaks one of its operating rules the bond is slashed instead.

Built for MozFest Developers Wilding: Online, using Otari as the control plane
rather than just the transport.

## Why this exists

Agent loops spend money without a receipt. Most frameworks treat a spend limit
as a config flag, not as something with consequences. Purse makes the cost of
thinking into a balance the agent has to hold, and gives a run three ways to end:

1. Released. The work holds up, the unspent bond returns.
2. Slashed. A guardrail tripped, the bond is taken.
3. Stopped. The meter hit zero mid task, nothing more can be spent.

## Two open weight models, for an economic reason

The loop runs on a small model because it takes hundreds of cheap steps. The
settlement decision runs on a larger model because getting it wrong costs more
than the tokens ever could. The split is not decoration, it is a cost argument.

Set both ids in `.env`. They must differ to exercise the distinct roles capability.

## The run

| Stage | Model | Tools attached | What it does |
|---|---|---|---|
| guard | none | none | checks the task against the operating rules |
| plan | loop model | none | turns the task into at most three steps |
| research | loop model | `otari_web_search` | gathers facts and cites them |
| verify | loop model | `otari_code_execution` | checks any number by running code |
| settle | settle model | none | releases or slashes the bond |
| ledger | none | none | books the cost and returns the remainder |

MCP servers registered in the workspace are attached to every stage through
`mcp_server_ids`, so the agent can read chain state through a tool rather than
inventing it.

## Otari capabilities exercised

- Per user budgets: one workspace key per user, each with its own ceiling
- Budgets and spending limits: the bond is a hard per request reserve
- Guardrails: a rule violation aborts the run and slashes the bond
- Model routing and fallbacks: the served model is logged next to the requested one, so a fallback is visible in the run log
- Multiple models serving distinct roles: loop model and settle model
- Web search: attached to the research stage
- Code execution: attached to the verify stage
- MCP integration: workspace MCP servers attached to every stage

## Run it

```bash
npm install
cp .env.example .env
```

Put two workspace keys in `.env`, one per user. Both come from the Otari
dashboard under API Keys. Each key is what the per user budget actually
attaches to, so do not share one key between users.

```bash
npm run dev
```

Open http://localhost:3000.

To work on the interface without burning calls, set `PURSE_MOCK=1`. Every call
is simulated and the page says so in a red bar.

## Demonstrating each capability

1. Normal run. The log shows the small model planning, researching and verifying, then the large model settling, with the bond falling each row.
2. Guardrail trip. Use the second preset. The guard stage refuses, nothing is spent, the bond is slashed.
3. Fallback. Break or revoke the primary provider key in the dashboard, then run again. The served model column changes, which means the routing policy moved the call.
4. Meter empty. Set a bond of 0.0005 and run. The ledger refuses the next call, the run stops, and the remainder is returned.

## Notes

`otari_web_search`, `otari_code_execution` and `otari_web_fetch` are request
level tool types. MCP servers are referenced by the id shown in
Tools to MCP servers in the dashboard.

The base URL is `https://otari.ai/api/v1` and the auth header is `Otari-Key`.
The documentation still shows `api.otari.ai` and `Authorization: Bearer` in
places. Those do not work against the hosted gateway.
