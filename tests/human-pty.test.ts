import { spawnSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pty from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type Approval,
  Gate,
  type Plan,
  type Provider,
} from '../src/core/gate.js';

const cli = resolve('dist/cli/index.js');
const roots: string[] = [];
const env = { ...process.env, CI: '', MCP_SERVER: '' } as Record<
  string,
  string
>;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function interactive(
  args: string[],
  exchanges: Array<[string, string]>,
): Promise<string> {
  const {
    promise,
    resolve: resolveOutput,
    reject,
  } = Promise.withResolvers<string>();
  const terminal = pty.spawn(process.execPath, [cli, ...args], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env,
  });
  let output = '';
  let remaining = '';
  let step = 0;
  // A real deadline is needed to terminate a child stuck waiting for a TTY prompt.
  const timer = setTimeout(() => {
    terminal.kill();
    reject(
      new Error(
        `Timed out waiting for ${exchanges[step]?.[0] ?? 'exit'}: ${output}`,
      ),
    );
  }, 30_000);
  terminal.onData((data) => {
    output += data;
    remaining += data;
    const exchange = exchanges[step];
    if (exchange) {
      const index = remaining.indexOf(exchange[0]);
      if (index !== -1) {
        remaining = remaining.slice(index + exchange[0].length);
        step++;
        terminal.write(`${exchange[1]}\r`);
      }
    }
  });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timer);
    if (exitCode !== 0 || step !== exchanges.length) {
      reject(
        new Error(
          `CLI exited ${exitCode} after ${step}/${exchanges.length} prompts: ${output}`,
        ),
      );
    } else resolveOutput(output);
  });
  return promise;
}

describe('human terminal approval', () => {
  it('initializes a key, approves the displayed plan, and executes with the signed approval', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-human-'));
    roots.push(root);
    const keys = join(root, 'keys');
    const passphrase = 'test-passphrase-not-a-secret';
    const initOutput = await interactive(
      ['keys', 'init', '--directory', keys],
      [
        ['Approval key passphrase:', passphrase],
        ['Approval key passphrase:', passphrase],
      ],
    );
    expect(initOutput).not.toContain(passphrase);
    const trustedPublicKeys = JSON.parse(
      await readFile(join(keys, 'trusted-approvers.json'), 'utf8'),
    );
    const plan: Plan = {
      provider: 'synthetic',
      target: 'production',
      operation: 'release',
      policy: { id: 'test-policy', mode: 'write' },
    };
    const configPath = join(root, 'android-kit.yaml');
    await writeFile(
      configPath,
      JSON.stringify({
        releaseGate: {
          directory: 'ledger',
          approvalDirectory: 'approvals',
          trustedPublicKeys,
          policies: [
            {
              provider: plan.provider,
              target: plan.target,
              operation: plan.operation,
              ...plan.policy,
            },
          ],
        },
      }),
    );
    let writes = 0;
    const provider: Provider = {
      inspect: async () => ({ revision: 'one' }),
      dryRun: async () => ({ change: 'release' }),
      execute: async () => {
        writes++;
        return { committed: true };
      },
      verify: async () => ({ verified: true }),
      reconcile: async () => ({ status: 'unresolved', evidence: {} }),
    };
    const gate = new Gate({
      directory: join(root, 'ledger'),
      trustedPublicKeys,
      authorizePlan: () => true,
    });
    const hash = await gate.plan(plan);
    const dry = await gate.dryRun(hash, provider);
    const output = await interactive(
      ['approve', hash, '--key-directory', keys, '--config', configPath],
      [
        ['Type the exact target to approve (production):', 'production'],
        ['Approval key passphrase:', passphrase],
      ],
    );
    expect(output).toContain(hash);
    expect(output).toContain(dry.evidenceHash);
    expect(output).not.toContain(passphrase);
    const approval = JSON.parse(
      await readFile(join(root, 'approvals', `${hash}.json`), 'utf8'),
    ) as Approval;
    expect(approval.planHash).toBe(hash);
    expect(approval.evidenceHash).toBe(dry.evidenceHash);
    await gate.execute(hash, approval, provider);
    expect(writes).toBe(1);
    await expect(gate.execute(hash, approval, provider)).rejects.toThrow();
    expect(writes).toBe(1);
  }, 60_000);

  it('refuses key initialization and approval when standard streams are not terminals', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-non-tty-'));
    roots.push(root);
    const configPath = join(root, 'android-kit.yaml');
    const { publicKey } = generateKeyPairSync('ed25519');
    await writeFile(
      configPath,
      JSON.stringify({
        releaseGate: {
          directory: 'ledger',
          approvalDirectory: 'approvals',
          trustedPublicKeys: {
            test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
          },
          policies: [],
        },
      }),
    );
    for (const args of [
      ['keys', 'init', '--directory', join(root, 'keys')],
      [
        'approve',
        'a'.repeat(64),
        '--key-directory',
        join(root, 'keys'),
        '--config',
        configPath,
      ],
    ]) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        env,
        input: 'production\ntest-passphrase\n',
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(
        /interactive terminal|human terminal/i,
      );
    }
    await expect(
      readFile(join(root, 'keys', 'approver.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      readFile(join(root, 'approvals', `${'a'.repeat(64)}.json`)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
