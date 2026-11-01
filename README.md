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
2. Slashed. A rule was broken, the bond is taken.
3. Stopped. The meter cannot cover the next call, so nothing more is spent.

## Two open weight models, for an economic reason

The loop runs on a small model because it takes several cheap steps. The
settlement decision runs on a larger model because getting that one wrong costs
more than the tokens ever could. The split is not decoration, it is a cost
argument, and it is the reason two distinct open weight models are in the run.

Set both ids in `.env`. They must differ.

## The run

| Stage | Model | Attached | What it does |
|---|---|---|---|
| guard | none | none | checks the task against the operating rules |
| policy | loop model | MCP server | reads the rulebook over MCP, outside the model |
| plan | loop model | none | turns the task into at most three steps |
| research | loop model | `otari_web_search` | gathers facts and cites them |
| verify | loop model | `otari_code_execution` | checks any number by running code |
| settle | settle model | none | decides whether the run produced a usable answer |
| ledger | none | none | books the cost and returns the remainder |

Before every stage the ledger checks that the bond can cover that kind of call,
so a run stops before the expensive call rather than after it. A plain chat call
reserves `PURSE_RESERVE_PLAIN_USD`; a tool or MCP call reserves
`PURSE_RESERVE_TOOL_USD`, because those bill far more.

## Otari capabilities exercised

- Multiple models serving distinct roles: `qwen3-30b-a3b-instruct-2507` runs the loop,
  `qwen3-next-80b-a3b-instruct` makes the settlement call. Both are open weight.
- Code execution: the verify stage runs `otari_code_execution` so a number is
  checked rather than guessed.
- MCP integration: the policy stage connects to an MCP server inline, so the
  rulebook is read over MCP instead of living in the prompt.
- Web search: the research stage runs `otari_web_search`.
- Budgets and spending limits: the bond is a hard per request reserve enforced by
  the ledger before every call, so a run physically cannot spend past it. An
  Otari budget and spend ceiling cap the workspace above that.
- Per user budgets: one workspace key per user, each capped by its own Otari
  budget and metered by its own bond, so Alice and Bob do not share a meter.

## What a live run costs

Measured against the hosted gateway with the defaults in `.env`:

| Call | Cost |
|---|---|
| plan, plain chat on the 30B model | about 0.00002 |
| policy, one MCP turn | about 0.0013 |
| research, one web search call | about 0.0104 |
| verify, one code execution call | about 0.0102 |
| settle, 80B instruct model | about 0.00008 |

A full run lands near 0.022 USD and takes about eighteen seconds, and almost all
of it is the two tool calls. That is why the reserve is per stage rather than one
flat number: a bond that covers twenty chat calls does not cover one web search
plus one code execution.

## Run it

```bash
npm install
cp .env.example .env
```

Put one workspace key per user in `.env`, both from the Otari dashboard. Each
key is what the per user budget attaches to, so do not share one key between
users.

```bash
npm run dev
```

Open http://localhost:3000.

To work on the interface without burning calls, set `PURSE_MOCK=1`. Every call
is simulated and the page says so in a red bar.

## Demonstrating each capability

1. Normal run. The log shows the small model reading the rulebook over MCP,
   planning, researching and verifying, then the large model settling, with the
   bond falling on every row. Ends released with about 0.178 of a 0.20 bond.
2. Rule violation. Click the preset. The guard stage matches the task against
   the rulebook in code, refuses before any model call, and takes the whole
   remaining bond. Nothing is spent on the task itself.
3. Meter empty. Set the bond to 0.035 and run. The policy, plan and research
   stages run, then verify is refused because 0.03 is reserved for a code
   execution call and only 0.0229 is left. The run stops there and that same
   0.0229 comes back unspent.
4. Second user. Click Run as Bob. His call goes out on his own key with his own
   budget, his meter falls, and Alice's stays at her full bond.

## Notes

`otari_web_search`, `otari_web_fetch` and `otari_code_execution` are request
level tool types. MCP servers can be passed inline as `mcp_servers` with a URL,
so nothing has to be registered in the dashboard first; `PURSE_MCP_URL` in
`.env` is the only setting that matters.

The base URL is `https://otari.ai/api/v1` and the auth header is `Otari-Key`.
The documentation still shows `api.otari.ai` and `Authorization: Bearer` in
places. Those do not work against the hosted gateway.

A long tool or MCP turn can outrun the edge timeout and come back as an HTML
502 or 504 rather than a JSON error, so the client trims the body for the log
and retries once.
