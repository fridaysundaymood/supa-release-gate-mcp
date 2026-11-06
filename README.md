# supa-release-gate-mcp

**Let AI agents deploy to production only after you approve the exact change.**

Every production write goes through the same steps: **plan → dry run → approval → execute → verify → record**. The approval is tied to a hash of the exact plan; if anything changes, it needs a new dry run and a new approval. Failed writes stop and are never retried automatically. Every step lands in an append-only ledger you can render as a changelog.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit), a toolkit combining five tools for end-to-end Android development. Works on its own; no other kit tool required.

## Status

> **Planning stage: there is no code to install yet.** This repo holds the design in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). Star or watch it to follow progress. First milestone: Supabase database migrations: dry run, approval, push, verification, and read-only SQL checks.

## Who it's for

- Developers letting AI agents help with releases who want a hard stop before anything touches production.
- Small teams that want an audit trail without a heavy CI/CD platform.

## What each approval shows

- **What:** the exact commands.
- **Where:** provider project, app, track, or environment.
- **Effect:** the dry-run result.
- **Rollback:** how to undo it, or a clear "irreversible".

## Provider roadmap

| Provider | Operations | Milestone |
|---|---|---|
| Supabase | Database push with migration dry run, read-only checks; later functions and secret references | M1 |
| Google Play | Preflight, track upload, release notes, staged rollout, halt, promote | M2 |
| Cloudflare | Pages deploys, DNS and routing changes with before/after diffs | M3 |
| Google Cloud | IAM diffs and bindings, API enable/disable | M3+ |

Secrets are only ever referenced, never stored in plans, output, or the ledger. The gate protects changes made through it; it does not replace CI/CD or block direct provider access.

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
