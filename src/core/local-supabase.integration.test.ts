import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Approval, canonicalJson, Gate, type Plan } from './gate.js';
import { createSupabaseProvider } from './providers/supabase.js';

const workdir = resolve('test/fixtures/local');
const cli = resolve(
  'node_modules/supabase/bin',
  process.platform === 'win32' ? 'supabase.exe' : 'supabase',
);
const migrationSource = resolve('../kit-fixture-app/supabase/migrations');
const migrations = join(workdir, 'supabase/migrations');
const enabled = process.env.RELEASE_GATE_LOCAL_INTEGRATION === '1';

describe.skipIf(!enabled)('local Supabase migration gate', () => {
  it('refuses unapproved and stale plans, then executes and verifies an approved plan', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'release-gate-integration-'),
    );
    try {
      await rm(migrations, { recursive: true, force: true });
      await cp(migrationSource, migrations, { recursive: true });
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const provider = createSupabaseProvider(
        { projectRef: 'ak-release', workdir, local: true, cli },
        'ak-release',
      );
      const gate = new Gate({
        directory,
        trustedPublicKeys: {
          test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        authorizePlan: (plan) =>
          plan.provider === 'supabase' &&
          plan.target === 'ak-release' &&
          plan.operation === 'db-push' &&
          plan.policy.id === 'integration' &&
          plan.policy.mode === 'write',
      });
      const plan: Plan = {
        provider: 'supabase',
        target: 'ak-release',
        operation: 'db-push',
        policy: { id: 'integration', mode: 'write' },
      };
      const hash = await gate.plan(plan);
      const dry = await gate.dryRun(hash, provider);
      const gateId = await gate.gateId();
      const approval = (): Approval => {
        const body = {
          kind: 'release-gate-approval-v1' as const,
          gateId,
          issuedAt: new Date().toISOString(),
          planHash: hash,
          target: plan.target,
          evidenceHash: dry.evidenceHash,
          policyId: plan.policy.id,
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
          nonce: randomUUID(),
          keyId: 'test',
        };
        return {
          ...body,
          signature: sign(
            null,
            Buffer.from(canonicalJson(body)),
            privateKey,
          ).toString('base64'),
        };
      };
      await expect(
        gate.execute(hash, { ...approval(), signature: '' }, provider),
      ).rejects.toThrow();
      const migration = join(migrations, '20260101000000_taskboard.sql');
      const original = await readFile(migration, 'utf8');
      await writeFile(migration, `${original}\n-- changed after approval\n`);
      await expect(gate.execute(hash, approval(), provider)).rejects.toThrow(
        /changed/,
      );
      await writeFile(migration, original);
      const result = await gate.execute(hash, approval(), provider);
      expect(result.verification).toEqual({ passed: true });
      expect((await gate.ledger()).map((entry) => entry.type)).toEqual([
        'plan',
        'dry-run',
        'intent',
        'outcome',
      ]);
    } finally {
      await rm(migrations, { recursive: true, force: true });
      await rm(directory, { recursive: true, force: true });
    }
  }, 180_000);
});
