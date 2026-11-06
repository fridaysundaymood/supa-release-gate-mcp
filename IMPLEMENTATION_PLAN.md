# Release Gate MCP: implementation plan

**Status: implementation present; local Supabase and live-provider verification remain subject to the integration environment and credentials.**

## Problem and goal

Production changes need an auditable approval describing the command, target, effect and rollback, preceded by a dry run and followed by verification. Manual preflight, provider-specific behavior and scattered records make that process error-prone.

Build a TypeScript core library on Node.js LTS, distributed as an npm package, with a CLI and a thin MCP adapter: **plan → dry run → human approval → execute → verify → record**. Bun is optional. The gate applies only to operations routed through it; it neither replaces CI/CD nor prevents direct provider access.

## Model and policy

A plan records the provider, exact target, operation, arguments, artifact digests, policy, provider state and dry-run inputs as canonical JSON. Its hash binds the approval to those bytes. Any change requires a new plan, dry run and approval. The approval view states the exact commands, target, intended effect, dry-run evidence, rollback or irreversibility, and separate-approval flags. Policy distinguishes reads, approved writes and actions requiring separate approval; never batch production actions.

Threat model: an agent can call every exposed MCP tool and may propose a malicious plan or replay an old approval. It must not be able to approve its own plan. A human reviews the complete plan and dry-run evidence through a channel the agent cannot drive, then runs `release approve <plan-hash>` in a separately controlled terminal. Enforce this boundary with OS account, filesystem and process permissions: the agent cannot invoke the approval command as the human, alter approval records or access the human's signing key. An optional OS-keychain-backed signing key can authenticate approval; a shared account or an agent with access to that key is not a valid boundary. MCP elicitation is an alternative only if supported by the client, explicitly permitted by policy, and the client provides a trusted human-only approval channel; otherwise fail closed. There is no MCP approval-granting tool. `release approve` is human-only, not an agent capability; its `--json` output follows the shared envelope.

Approvals bind the plan hash, target, dry-run evidence digest, policy identity, expiry and a unique single-use nonce. Verify authenticity and atomically consume the approval under the target lock before execution; reject expired, altered, mismatched or replayed approvals. Fail closed if the approval boundary cannot be established. Stop on failure; never automatically retry a write.

Immediately before execution, acquire a single-flight lock keyed by provider and target, re-read provider state and recompute all dry-run inputs, including the pending migration set and artifact digests. Refuse execution and require a new plan, dry run and approval if they differ or cannot be checked. Hold the lock through verification and ledger recording. This lock serializes gate operations, not external provider changes; use provider conditional writes or version preconditions where supported and disclose any remaining race where they are not.

## Provider adapters

Supabase is the first-class M1 adapter. Each adapter owns provider-specific commands, supported versions, dry run, execution, verification and rollback guidance. An operation without a genuine dry run must show an accurate before/after diff or disclose the limitation before approval; never present execution as a dry run.

| Provider     | Planned operations                                                                                            | Milestone                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Supabase     | Database push with pending-migration dry run, read-only SQL checks; function deploy and secrets by reference  | M1: database push and read-only checks; later: functions and secret references |
| Google Play  | Preflight, upload to track, release notes, rollout percentage, halt, promote; read tracks, vitals and reviews | M2                                                                             |
| Cloudflare   | Pages deploy from a committed directory; DNS and routing changes with before/after diffs                      | M3                                                                             |
| Google Cloud | IAM read/diff and bindings; API enable/disable using supported dry runs or policy diffs                       | M3 and later                                                                   |

The Supabase adapter handles non-interactive hosted-write requirements, uses read-only credentials and mode for checks, and avoids deprecated CLI options. For Play, create an edit, stage the intended changes, call [edits.validate](https://developers.google.com/android-publisher/api-ref/rest/v3/edits/validate), and do not commit it during dry run. Validation is not a release or a guarantee of later commit; recheck state and validate the execution edit before committing. Staging may upload artifacts and create an uncommitted edit; disclose those effects and clean up or let the edit expire.

## Verification and ledger

Verification records provider evidence rather than assuming a successful command means a successful change:

- Supabase migration: a subsequent database dry run reports no pending migrations; project-declared read-only checks can assert expected schema or scheduled-job state.
- Play: track state lists the intended version and release name.
- Pages: fetch the deployed URL and check expected content.

Maintain a per-project hash-chained JSONL ledger containing the plan, dry-run output digest, approval identity and time, execution intent and outcome, verification and commit links. Serialize and durably flush each record, including intent before any provider write. Validate the chain on open; reject corruption or a truncated tail until explicitly repaired. A chain detects alteration within the retained log but not deletion or replacement of the whole log: protect and independently anchor signed chain heads or retain them in a separately controlled append-only store where tamper evidence is required. Render a Markdown changelog on demand.

On restart, acquire the target lock and reconcile any intent without a durable outcome against provider state and operation identifiers. Record the observed outcome; if it cannot be established, mark it unresolved and block further writes to that target until a human resolves it. Never blindly replay an uncertain write. Recover stale locks only after confirming the owner is gone and performing reconciliation. Redact secrets from plans, logs, artifacts and ledger; use least-privilege, operation-scoped credentials via environment variables or OS keychain references, never credential values in configuration.

## Interfaces and configuration

The core library is the source of behavior; the CLI exposes every agent-accessible operation, and the MCP adapter exposes tools over stdio without client-specific requirements. Optional MCP features such as progress or elicitation degrade gracefully; without a trusted approval channel, approval remains blocked rather than bypassed. Ship plain Markdown `SKILL.md` files with frontmatter and an `AGENTS.md` snippet, usable by any agent; each agent-facing skill step names its CLI command and MCP equivalent. The human-only approval step names `release approve` and explicitly has no MCP equivalent.

| CLI command               | MCP tool                  |
| ------------------------- | ------------------------- |
| `release plan`            | `release_plan_change`     |
| `release dry-run`         | `release_dry_run`         |
| `release approval-status` | `release_approval_status` |
| `release execute`         | `release_execute`         |
| `release verify`          | `release_verify`          |
| `release ledger list`     | `release_ledger_list`     |
| `release ledger render`   | `release_ledger_render`   |
| `release status`          | `release_status`          |
| `release doctor`          | `release_doctor`          |

Every command supports `--json`, emitting the published `kit-schema` v1 JSON Schema envelope: `{ schema_version: "1", tool, operation, run_id, status: pass|fail|flaky|blocked|unsupported|error, classification?: app|test|environment|config, summary, evidence[], artifacts[], started_at, duration_ms }`. `fail` means the thing under test failed; `error` means the tool failed; `blocked` means a precondition or policy refused; `unsupported` means a capability is unavailable and is never silently skipped. Exit codes are 0 for pass, 1 for fail or flaky, and 2 for error, blocked, or unsupported. MCP returns the same envelope.

Configuration belongs only to the `releaseGate` section of `android-kit.yaml`, validated against a published JSON Schema with unknown keys rejected. No other tool's section is required. Store run artifacts under `.android-kit/runs/<run-id>/<tool>/`, separate from the protected ledger and approval authority. Configuration contains only credential references.

## Production readiness

Support Windows, macOS and Linux. Document OS-specific executable discovery, path handling, file locking and permissions; keychain integration depends on the available OS service, and fail closed when a secure approval boundary cannot be established. Declare and pin supported provider CLI and API versions, including Supabase CLI and Google Play Android Publisher API, and Node.js LTS; document compatible ranges where a provider API cannot be pinned. `release doctor` / `release_doctor` reports missing or incompatible prerequisites, version mismatches and actionable fixes without exposing credentials.

Use semver and maintain a CHANGELOG. Plan SECURITY.md and CONTRIBUTING.md in M1. CI runs unit tests on all three OSes and provider integration tests where feasible, using isolated synthetic fixtures and credentials. Emit structured, redacted logs; support interruption and crash recovery as described above, and make re-runs idempotent without repeating uncertain writes. No telemetry.

## Milestones

1. **M1 — Supabase:** core, CLI and MCP surfaces, shared schema and configuration, human-only approval enforcement, state machine, target lock, recoverable tamper-evident ledger, doctor and security/contribution guidance; database push with migration dry run, execution, verification and read-only SQL checks.
2. **M2 — Play:** preflight, uncommitted edit validation, locale-specific release-note length checks, track upload and verification using synthetic fixtures.
3. **M3 — Cloudflare and Google Cloud:** Pages and DNS adapters, plus GCP IAM read/diff; expand operations as supported dry runs and verification become available.
4. **M4 — broader policy and reporting:** extend separate-approval rules, rollback guidance and rendered changelog; add Supabase function deployment and secret-reference operations.

## Testing and risks

Use synthetic project, app, schema, migration and provider-output fixtures; never require private identifiers or production data. Cover CLI/MCP parity and schema validation, policy refusals, unsupported capabilities, non-interactive provider behavior, plan and provider-state changes, approval forgery, expiry and replay, agent denial at the human approval boundary, concurrent target executions, ledger tampering and crash points before and after a write. Test reconciliation of both known and ambiguous provider outcomes, including truncated ledger records; assert no uncertain write is retried. Provider changes can invalidate flags and validation behavior, so pin supported versions and keep version-specific behavior in adapters. Approval fatigue remains a risk; never batch production actions.

## Kit compatibility

This tool is also a component of [android-kit](https://github.com/fridaysundaymood/android-kit/blob/main/IMPLEMENTATION_PLAN.md). From M1 it follows the shared `kit-schema`, library-first composition, `releaseGate` configuration, prefixed MCP tools and shared synthetic fixture conventions; it also works independently.
