import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Approval,
  canonicalJson,
  Gate,
  hashJson,
  type Plan,
  type Provider,
} from '../src/core/gate.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('release gate', () => {
  it('binds approvals to fresh evidence, consumes them, and detects ledger damage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-gate-'));
    directories.push(directory);
    const keys = generateKeyPairSync('ed25519');
    const gate = new Gate({
      directory,
      trustedPublicKeys: {
        human: keys.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
      authorizePlan: (plan) =>
        plan.provider === 'example' &&
        plan.operation === 'deploy' &&
        plan.policy.id === 'production' &&
        plan.policy.mode === 'write',
    });
    const plan: Plan = {
      provider: 'example',
      target: 'production',
      operation: 'deploy',
      policy: { id: 'production', mode: 'write' },
    };
    let state = 'original';
    let writes = 0;
    const provider: Provider = {
      inspect: async () => state,
      dryRun: async () => ({ change: 'deploy' }),
      execute: async () => {
        writes++;
        return 'done';
      },
      verify: async () => 'verified',
      reconcile: async () => ({ status: 'unresolved', evidence: 'unknown' }),
    };
    const planHash = await gate.plan(plan);
    const { evidenceHash } = await gate.dryRun(planHash, provider);
    const unsigned = {
      planHash,
      target: plan.target,
      evidenceHash,
      policyId: plan.policy.id,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: 'single-use',
      keyId: 'human',
    };
    const approval: Approval = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(canonicalJson(unsigned)),
        keys.privateKey,
      ).toString('base64'),
    };
    state = 'changed';
    await expect(gate.execute(planHash, approval, provider)).rejects.toThrow(
      'changed',
    );
    state = 'original';
    await expect(
      gate.execute(planHash, { ...approval, target: 'other' }, provider),
    ).rejects.toThrow();
    await gate.execute(planHash, approval, provider);
    await expect(gate.execute(planHash, approval, provider)).rejects.toThrow(
      'consumed',
    );
    await expect(
      gate.execute(
        planHash,
        { ...approval, expiresAt: '2000-01-01T00:00:00.000Z' },
        provider,
      ),
    ).rejects.toThrow('expired');
    expect(writes).toBe(1);
    const ledger = join(directory, 'ledger.jsonl');
    await writeFile(ledger, (await readFile(ledger, 'utf8')).slice(0, -1));
    await expect(gate.ledger()).rejects.toThrow('Truncated');
  });
  it('requires a signed, single-use human resolution for uncertain writes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'release-gate-'));
    directories.push(directory);
    const keys = generateKeyPairSync('ed25519');
    const gate = new Gate({
      directory,
      trustedPublicKeys: {
        human: keys.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
      authorizePlan: () => true,
    });
    const plan: Plan = {
      provider: 'example',
      target: 'production',
      operation: 'deploy',
      policy: { id: 'policy', mode: 'write' },
    };
    const provider: Provider = {
      inspect: async () => 'state',
      dryRun: async () => 'diff',
      execute: async () => {
        throw new Error('connection lost');
      },
      verify: async () => 'verified',
      reconcile: async () => ({ status: 'unresolved', evidence: 'unknown' }),
    };
    const planHash = await gate.plan(plan);
    const { evidenceHash } = await gate.dryRun(planHash, provider);
    const unsigned = {
      planHash,
      target: plan.target,
      evidenceHash,
      policyId: 'policy',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: 'approval',
      keyId: 'human',
    };
    const approval = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(canonicalJson(unsigned)),
        keys.privateKey,
      ).toString('base64'),
    };
    await expect(gate.execute(planHash, approval, provider)).rejects.toThrow(
      'connection lost',
    );
    const intent = (await gate.ledger()).find((e) => e.type === 'intent');
    if (
      !intent?.data ||
      typeof intent.data !== 'object' ||
      Array.isArray(intent.data) ||
      typeof intent.data.intentId !== 'string'
    )
      throw new Error('Missing intent');
    const intentId = intent.data.intentId;
    const resolution = {
      kind: 'release-gate-resolution-v1' as const,
      provider: 'example',
      target: 'production',
      intentId,
      planHash,
      status: 'failed' as const,
      evidence: 'operator inspected state',
      issuedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      nonce: 'resolution',
      keyId: 'human',
    };
    const signed = {
      ...resolution,
      signature: sign(
        null,
        Buffer.from(canonicalJson(resolution)),
        keys.privateKey,
      ).toString('base64'),
    };
    await expect(
      gate.resolve({ ...signed, status: 'succeeded' }),
    ).rejects.toThrow();
    await gate.resolve(signed);
    await expect(gate.resolve(signed)).rejects.toThrow('already resolved');
  });
  it('canonicalizes key order and rejects unsupported values', () => {
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }));
    expect(() => canonicalJson({ value: undefined })).toThrow();
  });
});
