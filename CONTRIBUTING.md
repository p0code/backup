# Contributing

This is the backup plugin for [p0code](https://github.com/p0code/p0code): it encrypts your chats on
your machine and uploads the copy to Google Drive or S3-compatible storage.

Contributions are welcome — issues and small, focused PRs. I'm one busy person, so reviews and
replies can take a while. Please be patient and don't ping repeatedly; one polite bump after a
couple of weeks is fine.

## Setup

The plugin builds inside a p0code checkout (it imports `@t3tools/plugin-api` through the workspace).
There's also a `standalone/` setup for running the tests and typecheck without one:

```sh
cd standalone
pnpm install
pnpm test
pnpm typecheck
```

Inside a p0code checkout:

```sh
pnpm install
pnpm --filter @t3tools/plugin-backup typecheck
pnpm --filter @t3tools/plugin-backup test
```

## What makes a PR easy to land

- One thing per PR, with tests for behaviour changes. `standalone/` is enough for the pure logic.
- Conventional-commit-ish messages (`fix: ...`, `feat: ...`, `docs: ...`).
- No drive-by refactors or reformatting.
- Never commit real backups, keys or passphrases, and keep the remote seeing only ciphertext.

## License

MIT. By contributing you agree that your work is released under the MIT license. See
[LICENSE](LICENSE).
