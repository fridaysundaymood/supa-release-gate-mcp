import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSupabaseProvider,
  deployFunction,
  dryRunDatabasePush,
  executeDatabasePush,
  type ProcessRequest,
  runReadOnlySqlCheck,
  type SupabaseTarget,
  setSecretReferences,
  verifyDatabasePush,
} from './supabase.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function fixture(output = 'Remote database is up to date.') {
  const workdir = await mkdtemp(join(tmpdir(), 'supa-test-'));
  directories.push(workdir);
  await mkdir(join(workdir, 'supabase', '.temp'), { recursive: true });
  await mkdir(join(workdir, 'supabase', 'migrations'), { recursive: true });
  const projectRef = 'abcdefghijklmnopqrst';
  await writeFile(
    join(workdir, 'supabase', '.temp', 'project-ref'),
    projectRef,
  );
  const calls: ProcessRequest[] = [];
  const target: SupabaseTarget = {
    workdir,
    projectRef,
    runner: async (call) => {
      calls.push(call);
      return { exitCode: 0, stdout: output, stderr: '' };
    },
  };
  return { target, calls, workdir };
}

describe('Supabase provider', () => {
  it('parses separate CLI streams with a trailing upgrade notice', async () => {
    const { target } = await fixture();
    target.runner = async () => ({
      exitCode: 0,
      stdout: 'Finished supabase db push.\n',
      stderr:
        'DRY RUN: migrations will *not* be pushed to the database.\nConnecting to local database...\nWould push these migrations:\n • 20260101000000_taskboard.sql\n • 20260102000000_cleanup_cron.sql\nA new version of Supabase CLI is available: v3.0.0 (currently installed v2.75.0)\nWe recommend updating regularly for new features and bug fixes: https://supabase.com/docs/guides/cli/getting-started#updating-the-supabase-cli\n',
    });
    expect(await dryRunDatabasePush(target)).toEqual({
      pending: [
        '20260101000000_taskboard.sql',
        '20260102000000_cleanup_cron.sql',
      ],
      upToDate: false,
    });
  });
  it('parses a real dry run, binds pending migration bytes and refuses a different target', async () => {
    const { target, workdir } = await fixture(
      'DRY RUN: migrations will *not* be pushed to the database.\nWould push these migrations:\n • 20240101_create.sql\nFinished supabase db push.',
    );
    await writeFile(
      join(workdir, 'supabase', 'migrations', '20240101_create.sql'),
      'select 1;',
    );
    expect(await dryRunDatabasePush(target)).toEqual({
      pending: ['20240101_create.sql'],
      upToDate: false,
    });
    const provider = createSupabaseProvider(target, target.projectRef);
    const plan = {
      provider: 'supabase',
      target: target.projectRef,
      operation: 'db-push',
      policy: { id: 'p', mode: 'write' as const },
    };
    expect(await provider.inspect(plan)).toMatchObject({
      migrations: [{ name: '20240101_create.sql', sha256: expect.any(String) }],
    });
    await expect(
      provider.execute(
        { ...plan, target: 'wrong' },
        { state: null, evidence: null },
      ),
    ).rejects.toThrow('target mismatch');
    await writeFile(
      join(workdir, 'supabase', '.temp', 'project-ref'),
      'different',
    );
    await expect(executeDatabasePush(target)).rejects.toThrow('does not match');
  });
  it('supports local noninteractive execution and verifies using another dry run', async () => {
    const { target, calls } = await fixture();
    target.local = true;
    await executeDatabasePush(target);
    expect(await verifyDatabasePush(target)).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([
      ['db', 'push', '--local', '--yes'],
      ['db', 'push', '--local', '--dry-run'],
    ]);
  });
  it('fails closed on unknown dry-run output or process failure without leaking output', async () => {
    const { target } = await fixture('unknown secret');
    await expect(dryRunDatabasePush(target)).rejects.toThrow('Unrecognized');
    target.runner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'private-secret',
    });
    await expect(executeDatabasePush(target)).rejects.toThrow(
      'Provider command failed (exit 1)',
    );
  });
  it('runs a single SQL check in read-only transaction using referenced credentials', async () => {
    const { target, calls } = await fixture('1\n');
    target.env = {
      READ_URL: 'postgresql://reader:secret@db.example.test/postgres',
    };
    const check = {
      connectionEnv: 'READ_URL',
      host: 'db.example.test',
      database: 'postgres',
      sql: 'select 1',
      expected: '1',
    };
    expect(await runReadOnlySqlCheck(target, check)).toBe(true);
    expect(calls[0].stdin).toContain('BEGIN READ ONLY;');
    expect(calls[0].args.join(' ')).not.toContain('secret');
    await expect(
      runReadOnlySqlCheck(target, { ...check, host: 'elsewhere' }),
    ).rejects.toThrow('target mismatch');
    await expect(
      runReadOnlySqlCheck(target, { ...check, sql: 'select 1; delete from t' }),
    ).rejects.toThrow('single SELECT');
  });
  it('deploys to an explicit project and passes secrets only through a temporary file', async () => {
    const { target, calls } = await fixture();
    target.env = { TOKEN_REF: 'private value' };
    target.secretEnvAllowlist = ['TOKEN_REF'];
    let contents = '';
    let file = '';
    target.runner = async (call) => {
      calls.push(call);
      if (call.args[0] === 'secrets') {
        file = call.args[call.args.indexOf('--env-file') + 1];
        contents = await readFile(file, 'utf8');
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    await deployFunction(target, 'hello');
    await setSecretReferences(target, { TOKEN: 'TOKEN_REF' });
    expect(calls[0].args).toContain(target.projectRef);
    expect(contents).toContain('private value');
    expect(JSON.stringify(calls.map((call) => call.args))).not.toContain(
      'private value',
    );
    await expect(readFile(file)).rejects.toThrow();
  });
  it('denies unapproved and credential references before reading or invoking the CLI', async () => {
    const { target, calls } = await fixture();
    target.env = {
      TOKEN_REF: 'permitted',
      OTHER: 'unapproved',
      SUPABASE_ACCESS_TOKEN: 'provider-token',
      READ_URL: 'database-credential',
    };
    target.secretEnvAllowlist = [
      'TOKEN_REF',
      'SUPABASE_ACCESS_TOKEN',
      'READ_URL',
    ];
    target.credentialEnvDenylist = ['READ_URL'];
    for (const ref of ['OTHER', 'SUPABASE_ACCESS_TOKEN', 'READ_URL']) {
      await expect(setSecretReferences(target, { TOKEN: ref })).rejects.toThrow(
        'denied by host policy',
      );
    }
    const provider = createSupabaseProvider(target, target.projectRef);
    const plan = {
      provider: 'supabase',
      target: target.projectRef,
      operation: 'secrets-set',
      policy: { id: 'p', mode: 'write' as const },
      references: { TOKEN: 'READ_URL' },
    };
    await expect(
      provider.execute(plan, { state: null, evidence: null }),
    ).rejects.toThrow('denied by host policy');
    expect(calls).toEqual([]);
    target.secretEnvAllowlist = undefined;
    await expect(
      setSecretReferences(target, { TOKEN: 'TOKEN_REF' }),
    ).rejects.toThrow('denied by host policy');
  });
  it('executes only the captured secret values matching approved inputs', async () => {
    const { target } = await fixture('[]');
    target.snapshotKeyFile = join(target.workdir, 'snapshot.key');
    const env = { TOKEN_REF: 'approved' };
    target.env = env;
    target.secretEnvAllowlist = ['TOKEN_REF'];
    let written = '';
    target.runner = async (call) => {
      if (call.args.includes('--env-file')) {
        env.TOKEN_REF = 'changed during execution';
        written = await readFile(
          call.args[call.args.indexOf('--env-file') + 1],
          'utf8',
        );
      }
      return { exitCode: 0, stdout: '[]', stderr: '' };
    };
    const provider = createSupabaseProvider(target, target.projectRef);
    const plan = {
      provider: 'supabase',
      target: target.projectRef,
      operation: 'secrets-set',
      policy: { id: 'p', mode: 'write' as const },
      references: { TOKEN: 'TOKEN_REF' },
    };
    const state = await provider.inspect(plan);
    target.env.TOKEN_REF = 'changed';
    await expect(
      provider.execute(plan, { state, evidence: state }),
    ).rejects.toThrow('changed since approval');
    target.env.TOKEN_REF = 'approved';
    await provider.execute(plan, { state, evidence: state });
    expect(written).toContain('approved');
    expect(written).not.toContain('changed during execution');
  });
  it('discloses limited function and secret verification through the gate', async () => {
    const { target } = await fixture();
    target.snapshotKeyFile = join(
      target.workdir,
      'supabase',
      '.temp',
      'snapshot.key',
    );
    target.env = { TOKEN_REF: 'private value' };
    target.secretEnvAllowlist = ['TOKEN_REF'];
    target.runner = async (call) => ({
      exitCode: 0,
      stderr: '',
      stdout:
        call.args[1] !== 'list'
          ? ''
          : call.args[0] === 'functions'
            ? JSON.stringify([{ slug: 'hello', version: 2, status: 'ACTIVE' }])
            : JSON.stringify([{ name: 'TOKEN', value: 'remote-digest' }]),
    });
    const provider = createSupabaseProvider(target, target.projectRef);
    const common = {
      provider: 'supabase',
      target: target.projectRef,
      policy: { id: 'p', mode: 'write' as const },
    };
    const fn = { ...common, operation: 'function-deploy', function: 'hello' };
    const secret = {
      ...common,
      operation: 'secrets-set',
      references: { TOKEN: 'TOKEN_REF' },
    };
    expect(await provider.dryRun(fn)).toMatchObject({
      limitation: expect.stringContaining('No provider dry run'),
    });
    expect(await provider.verify(fn)).toEqual({
      observed: true,
      version: 2,
      status: 'ACTIVE',
      contentVerified: false,
    });
    const evidence = await provider.dryRun(secret);
    expect(
      await createSupabaseProvider(target, target.projectRef).dryRun(secret),
    ).toEqual(evidence);
    expect(JSON.stringify(evidence)).not.toContain('private value');
    expect(await provider.verify(secret)).toEqual({
      observedNames: ['TOKEN'],
      contentVerified: false,
    });
    expect((await provider.reconcile(fn)).status).toBe('unresolved');
  });
});
