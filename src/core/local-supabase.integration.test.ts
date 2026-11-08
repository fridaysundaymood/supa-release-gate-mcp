import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as pty from 'node-pty';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { protectFixtureDirectory } from '../../tests/protected-fixture.js';
import { loadReleaseConfig } from './config.js';
import type { Plan } from './gate.js';
import { ReleaseInterfaces } from './interfaces.js';
import { resolveProvider } from './providers.js';

const fixture = resolve('test/fixtures/local');
const supabaseCli = resolve(
  'node_modules/supabase/bin',
  process.platform === 'win32' ? 'supabase.exe' : 'supabase',
);
const releaseCli = resolve('dist/cli/index.js');
const migrationSource = resolve('../kit-fixture-app/supabase/migrations');
const enabled = process.env.RELEASE_GATE_LOCAL_INTEGRATION === '1';

function interactive(
  args: string[],
  exchanges: Array<[string, string]>,
): Promise<string> {
  const {
    promise,
    resolve: resolveOutput,
    reject,
  } = Promise.withResolvers<string>();
  const terminal = pty.spawn(process.execPath, [releaseCli, ...args], {
    name: 'xterm-color',
    cols: 120,
    rows: 40,
    cwd: process.cwd(),
    env: { ...process.env, CI: '', MCP_SERVER: '' } as Record<string, string>,
  });
  let output = '';
  let remaining = '';
  let step = 0;
  // The deadline terminates a real child process if it never reaches its prompt.
  const timer = setTimeout(() => {
    terminal.kill();
    reject(
      new Error(
        `Timed out waiting for ${exchanges[step]?.[0] ?? 'exit'}: ${output}`,
      ),
    );
  }, 90_000);
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
    if (exitCode !== 0 || step !== exchanges.length)
      reject(
        new Error(
          `CLI exited ${exitCode} after ${step}/${exchanges.length} prompts: ${output}`,
        ),
      );
    else resolveOutput(output);
  });
  return promise;
}

describe.skipIf(!enabled)('local Supabase migration gate', () => {
  it('requires human approval of current evidence before pushing and verifying staged migrations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'release-gate-integration-'));
    const projectTrust = await mkdtemp(resolve('release-gate-untrusted-'));
    try {
      protectFixtureDirectory(root);
      if (process.platform === 'darwin') {
        const require = createRequire(import.meta.url);
        const { dir } = require('node-pty/lib/utils.js').loadNativeModule(
          'pty',
        ) as { dir: string };
        const helper = resolve(
          require.resolve('node-pty/lib/utils.js'),
          '..',
          dir,
          'spawn-helper',
        );
        await chmod(helper, (await stat(helper)).mode | 0o111);
      }
      const workdir = join(root, 'project');
      await cp(fixture, workdir, { recursive: true });
      const migrations = join(workdir, 'supabase/migrations');
      await rm(migrations, { recursive: true, force: true });
      await cp(migrationSource, migrations, { recursive: true });
      const protectedCli = join(
        root,
        process.platform === 'win32' ? 'supabase.exe' : 'supabase',
      );
      await cp(supabaseCli, protectedCli);
      const keys = join(root, 'keys');
      const passphrase = 'integration-passphrase-not-a-secret';
      const init = await interactive(
        ['keys', 'init', '--directory', keys],
        [
          ['Approval key passphrase:', passphrase],
          ['Approval key passphrase:', passphrase],
        ],
      );
      expect(init).not.toContain(passphrase);
      const plan: Plan = {
        provider: 'supabase',
        target: 'ak-release',
        operation: 'db-push',
        policy: { id: 'integration', mode: 'write' },
      };
      const configPath = join(root, 'config.json');
      const trust = join(keys, 'trusted-approvers.json');
      const config = {
        releaseGate: {
          directory: 'ledger',
          approvalDirectory: 'approvals',
          trustedApproversFile: trust,
          policies: [
            {
              provider: plan.provider,
              target: plan.target,
              operation: plan.operation,
              ...plan.policy,
            },
          ],
          providers: {
            supabase: {
              projectRef: plan.target,
              workdir,
              local: 'true',
              cli: protectedCli,
            },
          },
        },
      };
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      const untrusted = join(projectTrust, 'trusted-approvers.json');
      await cp(trust, untrusted);
      const badConfig = join(root, 'untrusted-config.json');
      await writeFile(
        badConfig,
        JSON.stringify({
          releaseGate: {
            ...config.releaseGate,
            trustedApproversFile: untrusted,
          },
        }),
        { mode: 0o600 },
      );
      await expect(loadReleaseConfig(badConfig)).rejects.toThrow(
        /outside the project/i,
      );
      const settings = await loadReleaseConfig(configPath);
      const api = new ReleaseInterfaces(settings, (value) =>
        resolveProvider(settings, value),
      );
      const planned = await api.invoke('plan', { plan });
      expect(planned.status).toBe('pass');
      const { planHash: hash } = z
        .object({ planHash: z.string() })
        .parse(planned.evidence[0]);
      const dry = await api.invoke('dry-run', { planHash: hash });
      expect(dry.status).toBe('pass');
      const { evidenceHash } = z
        .object({ evidenceHash: z.string() })
        .parse(dry.evidence[0]);
      expect((await api.invoke('execute', { planHash: hash })).status).not.toBe(
        'pass',
      );
      const approve = async () => {
        const output = await interactive(
          ['approve', hash, '--key-directory', keys, '--config', configPath],
          [
            ['Approval key passphrase:', passphrase],
            ['Type the exact target to approve (ak-release):', 'ak-release'],
          ],
        );
        expect(output).toContain(hash);
        expect(output).not.toContain(passphrase);
        return output;
      };
      expect(await approve()).toContain(evidenceHash);
      const migration = join(migrations, '20260101000000_taskboard.sql');
      const original = await readFile(migration, 'utf8');
      await writeFile(migration, `${original}\n-- changed after approval\n`);
      const tampered = await api.invoke('execute', { planHash: hash });
      expect(tampered.status).toBe('blocked');
      expect(tampered.summary).toMatch(/changed/i);
      expect((await api.invoke('dry-run', { planHash: hash })).status).toBe(
        'pass',
      );
      await writeFile(migration, original);
      const stale = await api.invoke('execute', { planHash: hash });
      expect(stale.status).toBe('blocked');
      expect(stale.summary).toMatch(/approval/i);
      expect((await api.invoke('dry-run', { planHash: hash })).status).toBe(
        'pass',
      );
      await approve();
      const result = await api.invoke('execute', { planHash: hash });
      expect(result.status).toBe('pass');
      expect(
        z.object({ verification: z.unknown() }).parse(result.evidence[0])
          .verification,
      ).toEqual({ passed: true });
      const verify = await api.invoke('verify', { planHash: hash });
      expect(verify.status).toBe('pass');
      expect(verify.evidence[0]).toEqual({ passed: true });
      expect(
        (await api.gate.ledger()).filter((entry) => entry.type === 'intent'),
      ).toHaveLength(1);
    } finally {
      await rm(projectTrust, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  }, 300_000);
});
