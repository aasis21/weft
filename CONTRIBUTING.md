# Contributing to Weft

Weft welcomes focused bug fixes, documentation improvements, tests, and well-scoped
features.

## Before coding

- Search [existing issues](https://github.com/aasis21/weft/issues).
- For a substantial behavior or protocol change, open an issue first so the approach and
  compatibility impact can be discussed.
- Never include credentials, pairing payloads, private session content, or production
  relay secrets in an issue, test fixture, screenshot, or commit.

## Development

Use Node.js 20 or newer.

```sh
npm install --workspaces --include-workspace-root
npm test
npm run build -w @aasis21/weft-extension
npm run build -w @aasis21/weft-mobile
```

The monorepo contains `shared/`, `extension/`, and `mobile/` workspaces. Keep protocol
changes compatible across both ends, add focused tests near the changed behavior, and
update user documentation when commands, storage, privacy, or security behavior changes.
See [`docs/setup.md`](docs/setup.md) for the full local workflow.

## Pull requests

Keep each pull request focused. Explain the user-visible change, security or privacy
impact, compatibility considerations, and the tests you ran. By contributing, you agree
that your contribution is licensed under the repository's [Apache-2.0 license](LICENSE).

Use [`SECURITY.md`](SECURITY.md) for vulnerabilities and [`SUPPORT.md`](SUPPORT.md) for
usage questions.
