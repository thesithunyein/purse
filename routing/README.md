# Routing policy for the loop model

Purse can run its loop on an Otari routing policy instead of a single model id.
If the first model fails before it answers, Otari tries the fallback, and Purse
shows which one actually answered.

## What Purse reads

A routing policy keeps its own name in the response body's `model`, so the
body alone cannot show a fallback. Purse reads the response headers instead:

| Header | Shown as |
|---|---|
| `Otari-Model` | the model after the `->` in the model column |
| `Otari-Provider` | the provider named in the fallback note |
| `Otari-Fallback` | a yellow `fallback` tag on the row |
| `Otari-Attempt-Count` | "answered after N attempts" in the note |

The cost of the attempts that failed is absorbed by Otari and is not in
`usage.cost_usd`, so the bond is charged only for the model that answered.

## Set it up

Routing needs at least one provider key in Organization → Providers. In earlier
testing, managed models on the hosted gateway were skipped with
`managed_credential_unsupported`.

1. Add a provider key for the fallback model's provider.
2. Open Routing → Policies and create `purse-loop`:

   ```yaml
   select:
     - default: <primary open-weight model id>
   on_failure:
     - <fallback open-weight model id>
   ```

   Take both ids from `GET /api/v1/models`, and keep both open-weight.
3. Set `PURSE_LOOP_MODEL=purse-loop` in `.env`.
4. To see a fallback happen, set the primary to a model your workspace cannot
   reach. Otari serves the call from the fallback, and the row is tagged
   `fallback`.

A policy can also require a guardrail (`guardrails:` with `mode: block`). Purse
handles a refusal from a mandated guardrail the same way as one it asked for,
and slashes the bond.
