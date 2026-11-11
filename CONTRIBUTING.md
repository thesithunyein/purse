# Contributing

Thanks for helping. Small, focused pull requests are easiest to review.

## Set up

```bash
git clone -b otari https://github.com/thesithunyein/purse
cd purse
npm install
cp .env.example .env     # PURSE_MOCK=1 needs no key
npm run dev
```

## Before you open a pull request

```bash
npm test
npm run typecheck
```

Both run in CI on every pull request.

## Guidelines

- **Money stays in code.** A model may answer yes or no, or write text. It never
  sets an amount. Any new step reserves its worst case before it calls Otari.
- **Tests for behavior.** A change to how a run ends, or to what is charged,
  comes with a test in `test/`. Tests stub `fetch`; none touch the network.
- **Plain words in the UI.** Short sentences, no jargon, and say what it cost.
- **No secrets in commits.** Keys live in `.env`, which is git-ignored.
- **Keep it dependency-light.** Open an issue before adding a package.

## Reporting bugs and ideas

Use the issue templates. For security problems, see [SECURITY.md](SECURITY.md).

By contributing you agree your work is released under the [MIT License](LICENSE)
and you'll follow the [Code of Conduct](CODE_OF_CONDUCT.md).
