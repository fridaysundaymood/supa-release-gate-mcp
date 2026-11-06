# supa-release-gate-mcp

A planned release gate for changes that require human approval.

Changes routed through the gate follow **plan → dry run → human approval → execute → verify → record**. Approval binds the exact plan and expires; changed provider state requires a new plan. Failed or uncertain writes are not retried automatically. A hash-chained ledger records the workflow and supports crash reconciliation.

Planned for any MCP client or agent, or plain CLI and CI: a TypeScript library on Node.js LTS, an npm CLI and a thin stdio MCP adapter with `release_*` tools.

Part of [android-kit](https://github.com/fridaysundaymood/android-kit); it also works independently, with no other kit tool required.

## Status

**Planning stage: there is no code to install yet.** See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The first milestone covers Supabase database migration dry run, approval, push, verification and read-only SQL checks.

## Approval

The human reviews the exact commands, provider target, dry-run result and rollback or irreversibility. The planned `release approve <plan-hash>` command must run in a human-controlled terminal inaccessible to the agent. MCP elicitation is an alternative only when supported, policy permits it and the client provides a trusted human-only channel. No MCP tool grants approval. A shared account or signing key accessible to the agent does not provide this separation.

The gate protects only changes made through it; it does not replace CI/CD or block direct provider access. Credentials are least-privilege references from environment variables or OS keychains, not values stored in plans or the ledger.

## Provider roadmap

| Provider | Operations | Milestone |
|---|---|---|
| Supabase | Database push with migration dry run, read-only checks; later functions and secret references | M1 |
| Google Play | Preflight, uncommitted edit validation, track upload, release notes, staged rollout, halt, promote | M2 |
| Cloudflare | Pages deploys, DNS and routing changes with before/after diffs | M3 |
| Google Cloud | IAM diffs and bindings, API enable/disable | M3+ |

## Contributing

The design is open for feedback. Open an issue to question scope, suggest a feature, or discuss an approach before sending a pull request. Use synthetic examples only: no private app code, production data, or credentials.

## License

[MIT](LICENSE)
