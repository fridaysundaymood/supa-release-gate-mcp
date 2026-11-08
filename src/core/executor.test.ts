import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { externalExecute } from './executor.js';
import type { Approval, Plan } from './gate.js';

describe('external executor', () => {
  it('sends plan and approval over stdin without a shell', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gate-executor-'));
    const previousNodeOptions = process.env.NODE_OPTIONS;
    try {
      const file = join(dir, 'executor.cjs');
      await writeFile(
        file,
        'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{require("node:fs").writeSync(1,JSON.stringify(JSON.parse(s)));process.exit(0)});\n',
      );
      const plan: Plan = {
        provider: 'test',
        target: 'target',
        operation: 'change',
        policy: { id: 'p', mode: 'write' },
      };
      const approval: Approval = {
        kind: 'release-gate-approval-v1',
        gateId: 'gate',
        issuedAt: '2029-12-31T23:59:00Z',
        planHash: 'hash',
        target: 'target',
        evidenceHash: 'evidence',
        policyId: 'p',
        expiresAt: '2030-01-01T00:00:00Z',
        nonce: 'n',
        keyId: 'k',
        signature: 's',
      };
      process.env.NODE_OPTIONS = `--require ${JSON.stringify(file.replaceAll('\\', '/'))}`;
      const result = externalExecute(process.execPath, plan, approval);
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      expect(await result).toEqual({
        plan,
        approval,
      });
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
