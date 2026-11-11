# Security

## Reporting a vulnerability

Please don't open a public issue for a security problem.

Report it privately through GitHub: open the repository's **Security** tab and
click **Report a vulnerability**. Include what you found, how to reproduce it,
and what an attacker could do with it.

You'll get a reply within 7 days. Once it's fixed, you'll be credited in the
release notes unless you'd rather not be.

## Supported versions

Only the latest commit on the `otari` branch, which is what
[usepurse.vercel.app](https://usepurse.vercel.app) runs, gets security fixes.

## How Purse handles your key and money

- **Your Otari key** is kept in your browser's `localStorage`. It's sent in the
  `x-otari-key` header with your own requests only, used for that one request,
  and never written to disk or logs on the server. Remove it from the page at any
  time. Anyone with access to your browser profile can read it, as with any
  saved credential.
- **Spending** is capped twice: by the limit you set for each question, checked
  before every step, and by any budget you set on the key in Otari.
- **Shared accounts** on a deploy spend the owner's key, so they sit behind
  `PURSE_ACCESS_CODE` (compared in constant time) and `PURSE_MAX_BUDGET_USD`.
- **No wallet access.** Purse reads public prices and fees. It holds no funds and
  can't sign or send transactions.
- **Untrusted text.** Model output and web content are shown as text, never as
  HTML. Requests to move all funds, share a seed phrase, or override the rules
  are refused before any spend. An Otari guardrail can screen every step,
  including web content, when one is configured.

## Out of scope

- Prices or facts the model gets wrong. Report those as normal issues.
- Spend you approved by setting a limit.
- Issues in Otari itself. Report those to
  [mozilla-ai/otari](https://github.com/mozilla-ai/otari/security).
