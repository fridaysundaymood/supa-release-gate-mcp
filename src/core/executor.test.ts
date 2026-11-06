import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { externalExecute } from './executor.js';
import type { Approval, Plan } from './gate.js';

describe('external executor', () => {
  it.skipIf(process.platform === 'win32')(
    'sends plan and approval over stdin without a shell',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'gate-executor-'));
      try {
        const file = join(dir, 'executor');
        await writeFile(
          file,
          '#!/usr/bin/env node\nlet s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))));\n',
          { mode: 0o700 },
        );
        const plan: Plan = {
          provider: 'test',
          target: 'target',
          operation: 'change',
          policy: { id: 'p', mode: 'write' },
        };
        const approval: Approval = {
          planHash: 'hash',
          target: 'target',
          evidenceHash: 'evidence',
          policyId: 'p',
          expiresAt: '2030-01-01T00:00:00Z',
          nonce: 'n',
          keyId: 'k',
          signature: 's',
        };
        expect(await externalExecute(file, plan, approval)).toEqual({
          plan,
          approval,
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
