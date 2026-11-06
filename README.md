# Release Gate MCP

Release Gate routes supported changes through plan, dry run, human approval, execution, verification and a hash-chained ledger. It is a Node.js 24 TypeScript library, CLI and tools-only MCP server. It does not prevent direct provider access.

## From source

Clone `android-kit`, `kit-fixture-app` and this repository as siblings. Build the shared schema, install and build this project:

```sh
cd ../android-kit && npm ci && npm run build
cd ../supa-release-gate-mcp && npm ci && npm run build
node dist/cli/index.js keys init
```

The human chooses a passphrase in a terminal; the encrypted Ed25519 key and `trusted-approvers.json` are stored under the user configuration directory. Put the generated trusted-approvers file path in `android-kit.yaml`, alongside a protected ledger and explicitly allowed provider/target/operation policy:

```yaml
releaseGate:
  directory: .release-authority
  approvalDirectory: .release-approvals
  trustedApproversFile: trusted-approvers.json
  policies:
    - provider: supabase
      target: example
      operation: db-push
      id: production
      mode: write
  providers:
    supabase:
      projectRef: example
      workdir: .
```

Copy the generated public trust file to the indicated protected path and replace the illustrative target with an operator-controlled value; hosted Supabase project references must match the linked project. Keep credentials in environment variables or another protected credential store, not plans or configuration. Read-only SQL checks require genuinely read-only credentials; a read-only transaction alone cannot prevent side effects in privileged functions.

Prepare a JSON plan with `provider`, `target`, `operation`, and the matching `policy` object (`id`, `mode`), plus operation-specific arguments. Then:

```sh
node dist/cli/index.js doctor --json
node dist/cli/index.js plan plan.json --json
node dist/cli/index.js dry-run <plan-hash> --json
# Human only, in an interactive terminal after reviewing the full plan and evidence:
node dist/cli/index.js approve <plan-hash>
node dist/cli/index.js approval-status <plan-hash> --json
node dist/cli/index.js execute <plan-hash> --json
node dist/cli/index.js verify <plan-hash> --json
node dist/cli/index.js ledger render --json
```

A generic MCP client can launch `node` with arguments `dist/mcp/index.js` and an optional config path. The client must use the repository working directory or absolute executable paths. MCP exposes `release_plan_change`, `release_dry_run`, `release_approval_status`, `release_execute`, `release_verify`, `release_recover`, `release_ledger_list`, `release_ledger_render`, `release_status` and `release_doctor`; it does not expose approval or key creation.

## Trust and recovery

The human must keep the key passphrase private. TTY checks and encrypted keys protect the workflow only when the agent cannot access the passphrase or control the terminal. They are not protection from a fully malicious process running as the same OS user. For stronger isolation run the executor and credentials under a separate OS identity, protect the gate executable, config, trust store and state with OS ACLs, and configure `externalExecutor` as the protected executable. It receives JSON `{plan, approval}` on stdin and must independently authenticate approval and recheck provider state; the invoking process cannot enforce the executable's OS boundary. See [SECURITY.md](SECURITY.md).

Approvals bind plan, target, policy, dry-run evidence, expiry and a single-use nonce. The gate rechecks state under a per-target lock. External provider changes may race operations without conditional writes. An interrupted write is not retried; run `release recover <plan-hash>` or `release_recover` to reconcile its intent against provider state. If unresolved, a human must investigate and record the outcome using `release resolve <intent-id> --status succeeded|failed --evidence evidence.json` in an interactive terminal; there is no MCP resolution command. Protect and independently anchor ledger heads: the hash chain does not detect deletion or replacement of the entire ledger.

Supabase function and secret operations do not offer provider dry runs; their evidence discloses the limitation and metadata-only verification cannot establish deployed content. Play dry-run creates and validates an uncommitted edit, potentially uploading artifacts, then deletes the edit. Cloudflare DNS and Pages have no conditional gate lock against out-of-band changes. Live Play, Cloudflare and Google Cloud use requires the appropriate credentials and permissions.

## Development

Run `npm run lint`, `npm run build`, and `npm test`. The isolated local Supabase integration uses Docker, the pinned Supabase CLI and sibling fixture migrations: `node test/local-supabase.mjs`. It owns only the `ak-release` local stack. See [CONTRIBUTING.md](CONTRIBUTING.md). No telemetry is collected.

[MIT](LICENSE)
