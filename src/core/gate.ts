import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };
export interface Plan {
  provider: string;
  target: string;
  operation: string;
  policy: { id: string; mode: 'read' | 'write' };
  [key: string]: Json | undefined;
}
export interface Approval {
  kind: 'release-gate-approval-v1';
  gateId: string;
  planHash: string;
  target: string;
  evidenceHash: string;
  policyId: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  signature: string;
}
export interface Resolution {
  kind: 'release-gate-resolution-v1';
  provider: string;
  target: string;
  intentId: string;
  planHash: string;
  status: 'succeeded' | 'failed';
  evidence: Json;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
  keyId: string;
  signature: string;
}
export interface Provider {
  inspect(plan: Plan): Promise<Json>;
  dryRun(plan: Plan): Promise<Json>;
  execute(plan: Plan, approved: { state: Json; evidence: Json }): Promise<Json>;
  verify(plan: Plan): Promise<Json>;
  reconcile(
    plan: Plan,
  ): Promise<{ status: 'succeeded' | 'failed' | 'unresolved'; evidence: Json }>;
}
export interface LedgerEntry {
  sequence: number;
  previous: string;
  time: string;
  type: string;
  data: Json;
  hash: string;
}

/** Canonical JSON rejects values JSON.stringify would silently discard or normalize. */
export function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(v: unknown): string {
    if (v === null || typeof v === 'boolean' || typeof v === 'string')
      return JSON.stringify(v);
    if (typeof v === 'number' && Number.isFinite(v)) return JSON.stringify(v);
    if (typeof v !== 'object' || v === null || seen.has(v))
      throw new Error('Invalid canonical JSON value');
    seen.add(v);
    let result: string;
    if (Array.isArray(v)) {
      if (
        Object.keys(v).length !== v.length ||
        Object.keys(v).some((key, index) => key !== String(index))
      )
        throw new Error('Sparse or decorated array');
      result = `[${v.map(encode).join(',')}]`;
    } else {
      if (
        Object.getPrototypeOf(v) !== Object.prototype &&
        Object.getPrototypeOf(v) !== null
      )
        throw new Error('Invalid JSON object');
      const obj = v as Record<string, unknown>;
      result = `{${Object.keys(obj)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${encode(obj[k])}`)
        .join(',')}}`;
    }
    seen.delete(v);
    return result;
  }
  return encode(value);
}
export function hashJson(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}
const zero = '0'.repeat(64);
export const MAX_APPROVAL_LIFETIME_MS = 15 * 60_000;
const targetKey = (provider: string, target: string) =>
  hashJson([provider, target]);
const isRecord = (value: Json): value is { [key: string]: Json } =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Approval authorities are configured by the host, not supplied by MCP callers.
 * Each value is an Ed25519 public key in PEM format. Its private key and the
 * approval channel must be inaccessible to the agent. Shared-account deployments
 * cannot establish this boundary. Sign UTF-8 canonicalJson(approval without signature).
 * The directory must be private to this gate and reside on a local durable filesystem;
 * all gate processes must use the same directory and run on one host. The caller
 * must pin the public keys and protect the gate process and storage from the agent.
 * authorizePlan is trusted host policy: independently classify each provider,
 * target and operation, require the exact policy id/mode, and reject batches.
 * It must not accept an agent's claimed classification without checking it.
 * Do not store credentials in plans. A hash chain detects edits but needs an
 * independently retained head to detect rollback. A target lock cannot exclude
 * direct provider changes: adapters should use provider version preconditions.
 */
export class Gate {
  private readonly directory: string;
  private readonly trustedPublicKeys: Readonly<Record<string, string>>;
  private readonly authorizePlan: (plan: Plan) => boolean;
  constructor(options: {
    directory: string;
    trustedPublicKeys: Readonly<Record<string, string>>;
    authorizePlan: (plan: Plan) => boolean;
  }) {
    if (
      !options.directory ||
      !options.trustedPublicKeys ||
      !Object.keys(options.trustedPublicKeys).length ||
      typeof options.authorizePlan !== 'function'
    )
      throw new Error(
        'A protected directory, trusted human keys, and host policy are required',
      );
    for (const key of Object.values(options.trustedPublicKeys)) {
      if (createPublicKey(key).asymmetricKeyType !== 'ed25519')
        throw new Error('Only Ed25519 approval keys are supported');
    }
    this.directory = options.directory;
    this.trustedPublicKeys = { ...options.trustedPublicKeys };
    this.authorizePlan = options.authorizePlan;
  }
  async gateId(): Promise<string> {
    return this.withLock('identity', async () => {
      const path = join(this.directory, 'gate-id');
      try {
        const id = (await readFile(path, 'utf8')).trim();
        if (!/^[a-f0-9]{64}$/.test(id))
          throw new Error('Invalid gate identity');
        return id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const id = randomBytes(32).toString('hex');
        const file = await open(path, 'wx', 0o600);
        try {
          await file.writeFile(`${id}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
        return id;
      }
    });
  }
  private async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  private async lock(name: string): Promise<() => Promise<void>> {
    await this.init();
    const path = join(this.directory, `${name}.lock`);
    await mkdir(path, { mode: 0o700 });
    try {
      await writeFile(
        join(path, 'owner'),
        JSON.stringify({
          pid: process.pid,
          token: randomBytes(16).toString('hex'),
        }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      await rm(path, { recursive: true, force: true });
      throw error;
    }
    return async () => {
      await rm(path, { recursive: true });
    };
  }
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const release = await this.lock(name);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
  async ledger(): Promise<LedgerEntry[]> {
    await this.init();
    let text: string;
    try {
      text = await readFile(join(this.directory, 'ledger.jsonl'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
    if (text && !text.endsWith('\n')) throw new Error('Truncated ledger');
    const entries: LedgerEntry[] = [];
    for (const line of text ? text.slice(0, -1).split('\n') : []) {
      const entry = JSON.parse(line) as LedgerEntry;
      const { hash, ...body } = entry;
      if (
        entry.sequence !== entries.length ||
        entry.previous !== (entries.at(-1)?.hash ?? zero) ||
        hash !== hashJson(body) ||
        canonicalJson(entry) !== line
      )
        throw new Error('Corrupt ledger');
      entries.push(entry);
    }
    return entries;
  }
  private async append(type: string, data: Json): Promise<LedgerEntry> {
    return this.withLock('ledger', async () => {
      const entries = await this.ledger();
      const body = {
        sequence: entries.length,
        previous: entries.at(-1)?.hash ?? zero,
        time: new Date().toISOString(),
        type,
        data,
      };
      const entry = { ...body, hash: hashJson(body) };
      const file = await open(join(this.directory, 'ledger.jsonl'), 'a', 0o600);
      try {
        await file.writeFile(`${canonicalJson(entry)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      return entry;
    });
  }
  async plan(plan: Plan): Promise<string> {
    if (
      !plan.provider ||
      !plan.target ||
      !plan.operation ||
      !plan.policy?.id ||
      !['read', 'write'].includes(plan.policy.mode)
    )
      throw new Error('Invalid plan or policy');
    if (this.authorizePlan(plan) !== true)
      throw new Error('Plan denied by host policy');
    const hash = hashJson(plan);
    await this.append('plan', { hash, plan: plan as unknown as Json });
    return hash;
  }
  private async getPlan(hash: string): Promise<Plan> {
    const records = await this.ledger();
    const record = records.find(
      (e) => e.type === 'plan' && isRecord(e.data) && e.data.hash === hash,
    );
    if (
      !record ||
      !isRecord(record.data) ||
      !isRecord(record.data.plan) ||
      hashJson(record.data.plan) !== hash
    )
      throw new Error('Unknown plan');
    const plan = record.data.plan as unknown as Plan;
    if (this.authorizePlan(plan) !== true)
      throw new Error('Plan denied by host policy');
    return plan;
  }
  async dryRun(
    planHash: string,
    provider: Provider,
  ): Promise<{ state: Json; evidence: Json; evidenceHash: string }> {
    const plan = await this.getPlan(planHash);
    const state = await provider.inspect(plan);
    const evidence = await provider.dryRun(plan);
    const evidenceHash = hashJson({ state, evidence });
    await this.append('dry-run', { planHash, state, evidence, evidenceHash });
    return { state, evidence, evidenceHash };
  }
  async execute(
    planHash: string,
    approval: Approval,
    provider: Provider,
  ): Promise<{ outcome: Json; verification: Json }> {
    const plan = await this.getPlan(planHash);
    return this.withLock(
      `target-${targetKey(plan.provider, plan.target)}`,
      async () => {
        const records = await this.ledger();
        const pending = new Set<string>();
        for (const e of records)
          if (
            isRecord(e.data) &&
            e.data.targetKey === targetKey(plan.provider, plan.target) &&
            typeof e.data.intentId === 'string'
          ) {
            if (e.type === 'intent') pending.add(e.data.intentId);
            if (e.type === 'outcome' || e.type === 'reconciled')
              pending.delete(e.data.intentId);
            if (e.type === 'unresolved') pending.add(e.data.intentId);
          }
        if (pending.size)
          throw new Error('Unresolved execution requires reconciliation');
        const dry = [...records]
          .reverse()
          .find(
            (e) =>
              e.type === 'dry-run' &&
              isRecord(e.data) &&
              e.data.planHash === planHash,
          );
        if (!dry || !isRecord(dry.data)) throw new Error('Dry run required');
        const { signature, ...signed } = approval;
        const key = this.trustedPublicKeys[approval.keyId];
        const now = Date.now();
        const issuedAt = Date.parse(approval.issuedAt);
        const expiresAt = Date.parse(approval.expiresAt);
        if (
          !key ||
          approval.kind !== 'release-gate-approval-v1' ||
          approval.gateId !== (await this.gateId()) ||
          !Number.isFinite(issuedAt) ||
          issuedAt > now ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= issuedAt ||
          expiresAt - issuedAt > MAX_APPROVAL_LIFETIME_MS ||
          approval.planHash !== planHash ||
          approval.target !== plan.target ||
          approval.policyId !== plan.policy.id ||
          approval.evidenceHash !== dry.data.evidenceHash ||
          !approval.nonce ||
          expiresAt <= now
        )
          throw new Error('Invalid or expired approval');
        if (
          !verify(
            null,
            Buffer.from(canonicalJson(signed)),
            key,
            Buffer.from(signature, 'base64'),
          )
        )
          throw new Error('Invalid approval signature');
        if (
          records.some(
            (e) =>
              e.type === 'intent' &&
              isRecord(e.data) &&
              e.data.nonce === approval.nonce,
          )
        )
          throw new Error('Approval already consumed');
        const state = await provider.inspect(plan);
        const evidence = await provider.dryRun(plan);
        if (hashJson({ state, evidence }) !== approval.evidenceHash)
          throw new Error('Provider state or dry-run inputs changed');
        if (Date.parse(approval.expiresAt) <= Date.now())
          throw new Error('Approval expired');
        const intentId = randomBytes(16).toString('hex');
        const keyTarget = targetKey(plan.provider, plan.target);
        // The ledger lock makes nonce consumption atomic across targets and processes.
        await this.withLock('ledger', async () => {
          const latest = await this.ledger();
          if (
            latest.some(
              (e) =>
                e.type === 'intent' &&
                isRecord(e.data) &&
                e.data.nonce === approval.nonce,
            )
          )
            throw new Error('Approval already consumed');
          const body = {
            sequence: latest.length,
            previous: latest.at(-1)?.hash ?? zero,
            time: new Date().toISOString(),
            type: 'intent',
            data: {
              intentId,
              targetKey: keyTarget,
              planHash,
              nonce: approval.nonce,
              approval: approval as unknown as Json,
            },
          };
          const entry = { ...body, hash: hashJson(body) };
          const file = await open(
            join(this.directory, 'ledger.jsonl'),
            'a',
            0o600,
          );
          try {
            await file.writeFile(`${canonicalJson(entry)}\n`);
            await file.sync();
          } finally {
            await file.close();
          }
        });
        const outcome = await provider.execute(plan, { state, evidence });
        const verification = await provider.verify(plan);
        await this.append('outcome', {
          intentId,
          targetKey: keyTarget,
          planHash,
          outcome,
          verification,
        });
        return { outcome, verification };
      },
    );
  }
  /**
   * Recover only on the same host as the failed process. Missing owner metadata,
   * PID reuse, or permission errors require an operator to resolve the lock.
   */
  async recover(
    providerName: string,
    target: string,
    provider: Provider,
  ): Promise<void> {
    await this.withLock('recovery', async () => {
      for (const name of [
        'ledger',
        `target-${targetKey(providerName, target)}`,
      ]) {
        const path = join(this.directory, `${name}.lock`);
        let owner: { pid: number };
        try {
          owner = JSON.parse(await readFile(join(path, 'owner'), 'utf8')) as {
            pid: number;
          };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            try {
              await readFile(path);
            } catch (probe) {
              if ((probe as NodeJS.ErrnoException).code === 'ENOENT') continue;
            }
          }
          throw new Error(`Cannot establish owner of ${name} lock`);
        }
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          throw new Error(`Invalid ${name} lock owner`);
        try {
          process.kill(owner.pid, 0);
          throw new Error(`${name} lock owner may still be alive`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await rm(path, { recursive: true });
      }
      await this.reconcile(providerName, target, provider);
    });
  }
  async resolve(resolution: Resolution): Promise<void> {
    const { signature, ...signed } = resolution;
    const key = this.trustedPublicKeys[resolution.keyId];
    const issued = Date.parse(resolution.issuedAt);
    const expires = Date.parse(resolution.expiresAt);
    if (
      resolution.kind !== 'release-gate-resolution-v1' ||
      !key ||
      !resolution.provider ||
      !resolution.target ||
      !resolution.intentId ||
      !resolution.planHash ||
      !resolution.nonce ||
      !['succeeded', 'failed'].includes(resolution.status) ||
      !Number.isFinite(issued) ||
      !Number.isFinite(expires) ||
      issued > Date.now() ||
      expires <= Date.now() ||
      expires <= issued ||
      !verify(
        null,
        Buffer.from(canonicalJson(signed)),
        key,
        Buffer.from(signature, 'base64'),
      )
    ) {
      throw new Error('Invalid or expired human resolution');
    }
    const target = targetKey(resolution.provider, resolution.target);
    await this.withLock(`target-${target}`, async () => {
      await this.withLock('ledger', async () => {
        const entries = await this.ledger();
        const intent = entries.find(
          (e) =>
            e.type === 'intent' &&
            isRecord(e.data) &&
            e.data.intentId === resolution.intentId &&
            e.data.targetKey === target &&
            e.data.planHash === resolution.planHash,
        );
        if (
          !intent ||
          entries.some(
            (e) =>
              (e.type === 'outcome' || e.type === 'reconciled') &&
              isRecord(e.data) &&
              e.data.intentId === resolution.intentId,
          )
        ) {
          throw new Error('Intent is absent or already resolved');
        }
        if (
          entries.some(
            (e) =>
              e.type === 'reconciled' &&
              isRecord(e.data) &&
              isRecord(e.data.resolution) &&
              e.data.resolution.nonce === resolution.nonce,
          )
        ) {
          throw new Error('Resolution nonce already consumed');
        }
        if (expires <= Date.now()) throw new Error('Resolution expired');
        const data = {
          intentId: resolution.intentId,
          targetKey: target,
          planHash: resolution.planHash,
          status: resolution.status,
          evidence: resolution.evidence,
          resolution: resolution as unknown as Json,
        };
        const body = {
          sequence: entries.length,
          previous: entries.at(-1)?.hash ?? zero,
          time: new Date().toISOString(),
          type: 'reconciled',
          data,
        };
        const entry = { ...body, hash: hashJson(body) };
        const file = await open(
          join(this.directory, 'ledger.jsonl'),
          'a',
          0o600,
        );
        try {
          await file.writeFile(`${canonicalJson(entry)}\n`);
          await file.sync();
        } finally {
          await file.close();
        }
      });
    });
  }
  async reconcile(
    providerName: string,
    target: string,
    provider: Provider,
  ): Promise<void> {
    const key = targetKey(providerName, target);
    await this.withLock(`target-${key}`, async () => {
      const records = await this.ledger();
      for (const entry of records) {
        if (
          entry.type !== 'intent' ||
          !isRecord(entry.data) ||
          entry.data.targetKey !== key ||
          typeof entry.data.intentId !== 'string' ||
          typeof entry.data.planHash !== 'string'
        )
          continue;
        const intentId = entry.data.intentId;
        if (
          records.some(
            (e) =>
              (e.type === 'outcome' || e.type === 'reconciled') &&
              isRecord(e.data) &&
              e.data.intentId === intentId,
          )
        )
          continue;
        const result = await provider.reconcile(
          await this.getPlan(entry.data.planHash),
        );
        await this.append(
          result.status === 'unresolved' ? 'unresolved' : 'reconciled',
          {
            intentId,
            targetKey: key,
            planHash: entry.data.planHash,
            status: result.status,
            evidence: result.evidence,
          },
        );
      }
    });
  }
}

export function renderChangelog(entries: LedgerEntry[]): string {
  return entries
    .filter((e) => ['outcome', 'reconciled', 'unresolved'].includes(e.type))
    .map(
      (e) =>
        `## ${e.time} — ${e.type}\n\n\`\`\`json\n${JSON.stringify(e.data, null, 2)}\n\`\`\`\n`,
    )
    .join('\n');
}
