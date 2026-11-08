import { describe, expect, it } from 'vitest';
import type { ReleaseConfig } from './config.js';
import type { Plan } from './gate.js';
import { resolveProvider } from './providers.js';

describe('Supabase secret reference policy', () => {
  it('uses only the matching policy allowlist and denies configured credentials', async () => {
    const target = 'abcdefghijklmnopqrst';
    const plan: Plan = {
      provider: 'supabase',
      target,
      operation: 'secrets-set',
      policy: { id: 'restricted', mode: 'write' },
      references: { TOKEN: 'OTHER_POLICY_SECRET' },
    };
    const config: ReleaseConfig = {
      directory: '.',
      approvalDirectory: '.',
      trustedPublicKeys: {},
      providers: {
        supabase: { projectRef: target, workdir: '.' },
        play: { accessTokenEnv: 'PLAY_CREDENTIAL' },
      },
      supabaseChecks: {
        read: {
          connectionEnv: 'DB_CREDENTIAL',
          host: 'localhost',
          database: 'db',
          sql: 'select 1',
          expected: '1',
        },
      },
      policies: [
        {
          provider: 'supabase',
          target,
          operation: 'secrets-set',
          id: 'restricted',
          mode: 'write',
          secretEnvAllowlist: ['PLAY_CREDENTIAL', 'DB_CREDENTIAL'],
        },
        {
          provider: 'supabase',
          target,
          operation: 'secrets-set',
          id: 'other',
          mode: 'write',
          secretEnvAllowlist: ['OTHER_POLICY_SECRET'],
        },
      ],
    };
    const provider = resolveProvider(config, plan);
    for (const ref of [
      'OTHER_POLICY_SECRET',
      'PLAY_CREDENTIAL',
      'DB_CREDENTIAL',
    ]) {
      await expect(
        provider.execute(
          { ...plan, references: { TOKEN: ref } },
          { state: null, evidence: null },
        ),
      ).rejects.toThrow('denied by host policy');
    }
  });
});
