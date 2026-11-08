import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkReleaseHost, loadReleaseConfig } from '../src/core/config.js';
import { doctor } from '../src/core/doctor.js';
import { protectFixtureDirectory } from './protected-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function config() {
  const root = await mkdtemp(join(tmpdir(), 'release-host-'));
  roots.push(root);
  const path = join(root, 'config.json');
  await writeFile(
    path,
    JSON.stringify({
      releaseGate: {
        directory: 'ledger',
        approvalDirectory: 'approvals',
        trustedPublicKeys: { human: 'key' },
        policies: [],
      },
    }),
    { mode: 0o600 },
  );
  return { root, path };
}
it('rejects a host configuration located in the project before loading it', async () => {
  await expect(
    loadReleaseConfig(join(process.cwd(), 'untrusted-release-config.json')),
  ).rejects.toThrow(/outside the project/);
});

it.skipIf(process.platform !== 'win32')(
  'checks Windows ACLs independently of the inherited PowerShell module path',
  async () => {
    const { root, path } = await config();
    protectFixtureDirectory(root);
    const previous = Object.entries(process.env).find(
      ([name]) => name.toLowerCase() === 'psmodulepath',
    );
    delete process.env.PSModulePath;
    process.env.PSMODULEPATH = root;
    try {
      await expect(loadReleaseConfig(path)).resolves.toBeDefined();
      execFileSync(
        join(process.env.SystemRoot ?? '', 'System32', 'icacls.exe'),
        [path, '/grant', '*S-1-1-0:W'],
      );
      await expect(loadReleaseConfig(path)).rejects.toThrow(
        /Untrusted write access/,
      );
    } finally {
      delete process.env.PSMODULEPATH;
      if (previous) process.env[previous[0]] = previous[1];
    }
  },
);

describe.skipIf(process.platform === 'win32')(
  'protected release host configuration',
  () => {
    it('loads protected external paths and reports their status', async () => {
      const { root, path } = await config();
      const loaded = await loadReleaseConfig(path);
      expect(loaded.directory).toBe(join(root, 'ledger'));
      expect(
        (await doctor(loaded)).checks.find(
          (check) => check.name === 'host trust boundary',
        )?.ok,
      ).toBe(true);
      await chmod(path, 0o666);
      expect(
        (await doctor(loaded)).checks.find(
          (check) => check.name === 'host trust boundary',
        )?.ok,
      ).toBe(false);
      await expect(loadReleaseConfig(path)).rejects.toThrow(/not protected/);
    });

    it('rejects workspace paths and symlink escapes into the workspace', async () => {
      const { root, path } = await config();
      const loaded = await loadReleaseConfig(path);
      await expect(
        checkReleaseHost({ ...loaded, directory: process.cwd() }),
      ).rejects.toThrow(/outside the project/);
      const link = join(root, 'workspace');
      await symlink(process.cwd(), link, 'dir');
      await expect(
        checkReleaseHost({ ...loaded, directory: join(link, 'ledger') }),
      ).rejects.toThrow(/outside the project/);
    });

    it('rejects workspace configuration and relative executable overrides', async () => {
      const { path } = await config();
      const loaded = await loadReleaseConfig(path);
      await expect(
        checkReleaseHost({
          ...loaded,
          hostConfigPath: join(process.cwd(), 'config.json'),
        }),
      ).rejects.toThrow(/outside the project/);
      await expect(
        checkReleaseHost({
          ...loaded,
          providers: { supabase: { cli: 'supabase' } },
        }),
      ).rejects.toThrow(/absolute/);
    });
  },
);
