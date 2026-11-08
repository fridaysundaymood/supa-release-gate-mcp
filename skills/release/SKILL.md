---

name: release-gate
description: Plan, review, execute and verify a release through the release gate.
---

# Release gate

1. Check prerequisites with `release doctor --json` or MCP `release_doctor`.
2. Prepare a JSON plan and run `release plan plan.json --json` or MCP `release_plan_change` with the plan object. Record the returned plan hash.
3. Run `release dry-run <plan-hash> --json` or MCP `release_dry_run`. Review the target, intended effect, dry-run evidence, rollback or irreversibility, and the policy requirements.
4. A human uses a separately controlled terminal to run `release approve <plan-hash>`. There is deliberately no MCP equivalent. Do not request or handle the human's passphrase.
5. Check approval with `release approval-status <plan-hash> --json` or MCP `release_approval_status`; run `release execute <plan-hash> --json` or MCP `release_execute`. Do not retry an uncertain write.
6. Check provider evidence with `release verify <plan-hash> --json` or MCP `release_verify`; inspect the ledger with `release ledger list --json` or MCP `release_ledger_list` and render it with `release ledger render --json` or MCP `release_ledger_render`. Use `release status --json` or MCP `release_status` for the gate status.
7. After interruption, run `release recover <plan-hash> --json` or MCP `release_recover`; if the outcome remains unresolved, stop and have a human investigate provider state. Never replay the write.
