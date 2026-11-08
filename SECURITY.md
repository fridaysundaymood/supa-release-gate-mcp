# Security

Report suspected vulnerabilities privately to the repository maintainers; do not include credentials or production data in an issue.

The gate protects only operations routed through it, not direct provider access. Approval uses a passphrase-encrypted human signing key and a human-operated terminal; never disclose the passphrase to an agent. This can prevent accidental or injected approval through the MCP interface, but a fully malicious process running under the same OS account is not contained: it can manipulate local files, interfere with terminal input, or use provider credentials directly. For a stronger boundary, run the executor under a separate OS identity or service with protected code, configuration, approval keys, persistent state, and provider credentials; ensure the agent cannot impersonate that identity. A shared account is not an adequate boundary against a malicious local agent.

Use least-privilege credentials and keep their values out of configuration, plans, logs, and ledger. The hash chain detects modifications within the retained ledger but not deletion or wholesale replacement. Independently retain and authenticate chain heads for stronger tamper evidence. A gate target lock does not prevent out-of-band changes; use provider preconditions where available, and recognize the residual race otherwise. Never retry an uncertain write without reconciliation.

The release authority configuration, trusted approvers, approvals, ledger and executor must be controlled by the host and stored outside the project. Project files and MCP inputs must not choose executables or authority settings. On Windows the authority requires explicit ACLs; use the doctor command to check the setup. A protected host configuration is not a substitute for running an untrusted agent under a separate OS identity.

Approvals are specific to one gate and bind the plan, evidence, issuance time, expiry and nonce. Protect the persistent gate identity and ledger from rollback or replacement. Secret-setting plans may refer only to host-allowed environment names; provider and database credentials and reserved credential prefixes are denied.

Execution must use verified private copies of approved artifacts rather than files writable by the project. Pages deployments use the approved Git commit, not a mutable working tree. These controls do not prevent an actor with access to the protected executor identity or the provider from changing the release directly.
