#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { createResult, exitCodeFor, newRunId } from '@budaknyenyel/kit-schema';
import {
  initApprover,
  promptPassphrase,
  promptResolution,
} from '../core/approver.js';
import { loadReleaseConfig } from '../core/config.js';
import type { Json, Plan, Resolution } from '../core/gate.js';
import { type Operation, ReleaseInterfaces } from '../core/interfaces.js';
import { isEntrypoint } from '../core/is-entrypoint.js';
import { resolveProvider } from '../core/providers.js';

export async function runCli(args: string[]): Promise<number> {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    stdout.write(`Usage: release [--config PATH] [--json] COMMAND

Commands:
  keys init [--directory PATH]     Create a human approver key
  plan FILE                        Record a release plan
  dry-run HASH                     Inspect and dry-run a plan
  approve HASH [--key-directory PATH] [--expires ISO]
                                   Review and sign an approval
  approval-status HASH             Inspect approval status
  execute HASH                     Execute an approved plan
  verify HASH                      Verify a release
  recover HASH                     Reconcile an interrupted release
  resolve INTENT --status succeeded|failed --evidence FILE
                                   Sign a human resolution
  ledger list|render               Inspect the release ledger
  status                           Show pending releases
  doctor                           Check configuration
`);
    return 0;
  }
  const values = [...args];
  const defaultKeyDir = join(
    process.env.APPDATA ??
      process.env.XDG_CONFIG_HOME ??
      join(homedir(), '.config'),
    'android-kit',
    'release-gate',
  );
  const flag = (name: string, fallback?: string): string | undefined => {
    const i = values.indexOf(name);
    if (i < 0) return fallback;
    const value = values[i + 1];
    if (!value || value.startsWith('--'))
      throw new Error(`Missing value for ${name}`);
    values.splice(i, 2);
    return value;
  };
  const configPath = flag('--config');
  const json = values.includes('--json');
  if (json) values.splice(values.indexOf('--json'), 1);
  const command = values.shift();
  if (command === 'keys') {
    if (values.shift() !== 'init')
      throw new Error('Usage: release keys init --directory PATH');
    const directory = flag('--directory', defaultKeyDir);
    if (!directory || values.length)
      throw new Error('Usage: release keys init --directory PATH');
    const first = await promptPassphrase();
    const second = await promptPassphrase();
    if (first !== second) throw new Error('Passphrases do not match');
    const authority = await initApprover(directory, first);
    await writeFile(
      join(directory, 'trusted-approvers.json'),
      JSON.stringify({ [authority.keyId]: authority.publicKey }, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    stdout.write(
      `${JSON.stringify(json ? createResult({ tool: 'release', operation: 'keys-init', run_id: newRunId(), status: 'pass', summary: 'Approver key created', evidence: [authority], artifacts: [], startedAt: new Date() }) : authority)}\n`,
    );
    return 0;
  }
  const config = await loadReleaseConfig(configPath);
  const api = new ReleaseInterfaces(config, (plan) =>
    resolveProvider(config, plan),
  );
  if (command === 'approve') {
    if (
      !stdin.isTTY ||
      !stdout.isTTY ||
      process.env.CI ||
      process.env.MCP_SERVER
    )
      throw new Error(
        'Approval requires a separately controlled human terminal',
      );
    const hash = values.shift();
    const key = flag('--key-directory', defaultKeyDir);
    const expires = flag(
      '--expires',
      new Date(Date.now() + 15 * 60_000).toISOString(),
    );
    if (!hash || !key || !expires || values.length)
      throw new Error(
        'Usage: release approve HASH --key-directory PATH --expires ISO',
      );
    const approval = await api.approve(hash, key, expires);
    stdout.write(
      `${JSON.stringify(json ? createResult({ tool: 'release', operation: 'approve', run_id: newRunId(), status: 'pass', summary: 'Approval signed', evidence: [{ planHash: approval.planHash, expiresAt: approval.expiresAt }], artifacts: [], startedAt: new Date() }) : { planHash: approval.planHash, expiresAt: approval.expiresAt })}\n`,
    );
    return 0;
  }
  if (command === 'resolve') {
    if (
      !stdin.isTTY ||
      !stdout.isTTY ||
      process.env.CI ||
      process.env.MCP_SERVER
    )
      throw new Error(
        'Resolution requires a separately controlled human terminal',
      );
    const intentId = values.shift();
    const status = flag('--status');
    const evidenceFile = flag('--evidence');
    const keyDirectory = flag('--key-directory', defaultKeyDir);
    if (
      !intentId ||
      (status !== 'succeeded' && status !== 'failed') ||
      !evidenceFile ||
      !keyDirectory ||
      values.length
    )
      throw new Error(
        'Usage: release resolve INTENT_ID --status succeeded|failed --evidence FILE',
      );
    const entries = await api.gate.ledger();
    const intent = entries.find(
      (entry) =>
        entry.type === 'intent' &&
        (entry.data as Record<string, unknown>).intentId === intentId,
    );
    if (!intent) throw new Error('Unknown intent');
    const planHash = (intent.data as Record<string, unknown>).planHash;
    const planEntry = entries.find(
      (entry) =>
        entry.type === 'plan' &&
        (entry.data as Record<string, unknown>).hash === planHash,
    );
    if (!planEntry || typeof planHash !== 'string')
      throw new Error('Unknown intent plan');
    const plan = (planEntry.data as Record<string, unknown>).plan as Plan;
    const evidence = JSON.parse(await readFile(evidenceFile, 'utf8')) as Json;
    const payload: Omit<Resolution, 'keyId' | 'signature'> = {
      kind: 'release-gate-resolution-v1',
      provider: plan.provider,
      target: plan.target,
      intentId,
      planHash,
      status,
      evidence,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      nonce: randomBytes(32).toString('hex'),
    };
    (json ? process.stderr : stdout).write(
      `${JSON.stringify({ intent, plan, resolution: payload }, null, 2)}\n`,
    );
    const resolution = await promptResolution(keyDirectory, payload);
    await api.gate.resolve(resolution);
    const result = createResult({
      tool: 'release',
      operation: 'resolve',
      run_id: newRunId(),
      status: 'pass',
      summary: 'Resolution recorded',
      evidence: [{ intentId, status }],
      artifacts: [],
      startedAt: new Date(),
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }
  const operation = command === 'ledger' ? `ledger-${values.shift()}` : command;
  const allowed = [
    'plan',
    'dry-run',
    'approval-status',
    'execute',
    'verify',
    'recover',
    'ledger-list',
    'ledger-render',
    'status',
    'doctor',
  ];
  if (!operation || !allowed.includes(operation))
    throw new Error('Unknown command');
  const input: Record<string, unknown> = {};
  if (operation === 'plan') {
    const file = values.shift();
    if (!file) throw new Error('Plan JSON file required');
    input.plan = JSON.parse(await readFile(file, 'utf8'));
  } else if (
    ['dry-run', 'approval-status', 'execute', 'verify', 'recover'].includes(
      operation,
    )
  )
    input.planHash = values.shift();
  if (values.length)
    throw new Error(`Unexpected arguments: ${values.join(' ')}`);
  const result = await api.invoke(operation as Operation, input);
  stdout.write(`${JSON.stringify(result, null, json ? undefined : 2)}\n`);
  return exitCodeFor(result.status);
}

if (isEntrypoint(import.meta.url))
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      const summary = error instanceof Error ? error.message : String(error);
      const result = createResult({
        tool: 'release',
        operation: process.argv[2] ?? 'unknown',
        run_id: newRunId(),
        status: 'error',
        classification: 'config',
        summary,
        evidence: [],
        artifacts: [],
        startedAt: new Date(),
      });
      if (process.argv.includes('--json'))
        stdout.write(`${JSON.stringify(result)}\n`);
      else console.error(JSON.stringify(result));
      process.exitCode = 2;
    });
