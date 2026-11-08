import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { resolveProvider } from '../providers.js';
import { createCloudflareGateProvider } from './cloud-gate.js';
import { playExecute } from './play.js';
import { createSupabaseProvider } from './supabase.js';

const exec = promisify(execFile);

describe('approved content execution', () => {
  it('uploads the exact Play bytes hashed before the edit is created', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'play-content-'));
    try {
      const bundlePath = join(dir, 'app.aab');
      await writeFile(bundlePath, 'approved');
      const digest = createHash('sha256').update('approved').digest('hex');
      let uploaded = '';
      const fetcher: typeof fetch = async (url, init) => {
        const path = String(url);
        if (path.endsWith('/edits')) {
          await writeFile(bundlePath, 'modified');
          return Response.json({ id: 'edit' });
        }
        if (path.includes('/bundles?')) {
          uploaded = Buffer.from(init?.body as Uint8Array).toString();
          return Response.json({ versionCode: 42 });
        }
        return Response.json({});
      };
      await playExecute(
        { packageName: 'test', accessToken: 'token', fetch: fetcher },
        {
          bundlePath,
          track: 'internal',
          release: {
            name: 'release',
            versionCodes: ['42'],
            status: 'completed',
          },
        },
        digest,
      );
      expect(uploaded).toBe('approved');
      await expect(
        playExecute(
          { packageName: 'test', accessToken: 'token', fetch: fetcher },
          {
            bundlePath,
            track: 'internal',
            release: {
              name: 'release',
              versionCodes: ['42'],
              status: 'completed',
            },
          },
          digest,
        ),
      ).rejects.toThrow('changed since approval');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('executes Supabase migrations from a captured workspace and rejects changes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'supa-content-'));
    try {
      const migrations = join(dir, 'supabase', 'migrations');
      await mkdir(migrations, { recursive: true });
      const file = join(migrations, '20240101_test.sql');
      await writeFile(file, 'approved');
      let executed = '';
      const target = {
        workdir: dir,
        projectRef: 'local',
        local: true,
        runner: async (call: { args: string[]; cwd: string }) => {
          if (call.args.includes('--dry-run'))
            return {
              exitCode: 0,
              stdout:
                'Would push these migrations:\n • 20240101_test.sql\nFinished supabase db push.',
              stderr: '',
            };
          await writeFile(file, 'modified');
          executed = await readFile(
            join(call.cwd, 'supabase', 'migrations', '20240101_test.sql'),
            'utf8',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      const provider = createSupabaseProvider(target, 'local');
      const plan = {
        provider: 'supabase',
        target: 'local',
        operation: 'db-push',
        policy: { id: 'p', mode: 'write' as const },
      };
      const state = await provider.inspect(plan);
      await provider.execute(plan, { state, evidence: state });
      expect(executed).toBe('approved');
      await expect(
        provider.execute(plan, { state, evidence: state }),
      ).rejects.toThrow('changed since approval');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('deploys the captured function workspace, not later source edits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'function-content-'));
    const keys = await mkdtemp(join(tmpdir(), 'function-key-'));
    try {
      const functions = join(dir, 'supabase', 'functions', 'hello');
      await mkdir(functions, { recursive: true });
      const file = join(functions, 'index.ts');
      await writeFile(file, 'approved');
      let deployed = '';
      const target = {
        workdir: dir,
        projectRef: 'abcdefghijklmnopqrst',
        snapshotKeyFile: join(keys, 'key'),
        runner: async (call: { args: string[]; cwd: string }) => {
          if (call.args[1] === 'list')
            return { exitCode: 0, stdout: '[]', stderr: '' };
          await writeFile(file, 'modified');
          deployed = await readFile(
            join(call.cwd, 'supabase', 'functions', 'hello', 'index.ts'),
            'utf8',
          );
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      };
      const provider = createSupabaseProvider(target, target.projectRef);
      const plan = {
        provider: 'supabase',
        target: target.projectRef,
        operation: 'function-deploy',
        function: 'hello',
        policy: { id: 'p', mode: 'write' as const },
      };
      const state = await provider.inspect(plan);
      await provider.execute(plan, { state, evidence: state });
      expect(deployed).toBe('approved');
      await expect(
        provider.execute(plan, { state, evidence: state }),
      ).rejects.toThrow('changed since approval');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(keys, { recursive: true, force: true });
    }
  });

  it('rejects Play bundles outside the project root before contacting Play', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'play-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'play-outside-'));
    const previous = process.env.RELEASE_TEST_PLAY_TOKEN;
    try {
      process.env.RELEASE_TEST_PLAY_TOKEN = 'token';
      const bundlePath = join(outside, 'app.aab');
      await writeFile(bundlePath, 'bundle');
      const plan = {
        provider: 'play',
        target: 'test',
        operation: 'release',
        policy: { id: 'p', mode: 'write' as const },
        args: {
          bundlePath,
          track: 'internal',
          release: {
            name: 'release',
            versionCodes: ['42'],
            status: 'completed',
          },
        },
      };
      const provider = resolveProvider(
        {
          directory: dir,
          approvalDirectory: dir,
          projectRoot: dir,
          trustedPublicKeys: {},
          policies: [],
          providers: {
            play: {
              packageName: 'test',
              accessTokenEnv: 'RELEASE_TEST_PLAY_TOKEN',
            },
          },
        },
        plan,
      );
      await expect(provider.dryRun(plan)).rejects.toThrow(
        'outside the project root',
      );
      await expect(provider.verify(plan)).rejects.toThrow(
        'outside the project root',
      );
    } finally {
      if (previous === undefined) delete process.env.RELEASE_TEST_PLAY_TOKEN;
      else process.env.RELEASE_TEST_PLAY_TOKEN = previous;
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects Pages directories outside the trusted root and changed content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pages-content-'));
    try {
      await exec('git', ['init'], { cwd: dir });
      await exec('git', ['config', 'user.email', 'test@example.test'], {
        cwd: dir,
      });
      await exec('git', ['config', 'user.name', 'Test'], { cwd: dir });
      await mkdir(join(dir, 'site'));
      await writeFile(join(dir, 'site', 'index.html'), 'approved');
      await exec('git', ['add', '.'], { cwd: dir });
      await exec('git', ['commit', '-m', 'test'], { cwd: dir });
      const provider = createCloudflareGateProvider({
        token: 'x',
        accountId: 'x',
        projectRoot: dir,
        pagesRoot: join(dir, 'site'),
      });
      const plan = {
        provider: 'cloudflare',
        target: 'site',
        operation: 'pages-deploy',
        policy: { id: 'p', mode: 'write' as const },
        args: {
          directory: join(dir, 'site'),
          url: 'https://example.test',
          expectedContent: 'approved',
        },
      };
      const evidence = await provider.dryRun(plan);
      await expect(
        provider.dryRun({ ...plan, args: { ...plan.args, directory: dir } }),
      ).rejects.toThrow('outside the trusted root');
      await writeFile(join(dir, 'site', 'index.html'), 'modified');
      await expect(
        provider.execute(plan, { state: null, evidence }),
      ).rejects.toThrow('uncommitted');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
