import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { Json, Plan, Provider } from '../gate.js';

export interface ProcessRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin?: string;
}
export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;
export interface SupabaseTarget {
  projectRef: string;
  workdir: string;
  local?: boolean;
  cli?: string;
  env?: NodeJS.ProcessEnv;
  runner?: ProcessRunner;
  snapshotKeyFile?: string;
}
export interface MigrationDryRun {
  pending: string[];
  upToDate: boolean;
}

export const runProcess: ProcessRunner = async (request) => {
  const child = spawn(request.command, request.args, {
    cwd: request.cwd,
    env: request.env,
    shell: false,
    stdio: 'pipe',
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(request.stdin);
  try {
    const [code] = (await once(child, 'close')) as [number | null];
    return { exitCode: code ?? -1, stdout, stderr };
  } catch {
    throw new Error('Could not start provider command');
  }
};

function validRef(ref: string): void {
  if (!/^[a-z0-9]{20}$/.test(ref))
    throw new Error('Invalid Supabase project reference');
}
function validName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name))
    throw new Error('Invalid function or secret name');
}
async function linked(target: SupabaseTarget): Promise<void> {
  if (target.local) return;
  validRef(target.projectRef);
  let ref: string;
  try {
    ref = (
      await readFile(
        join(target.workdir, 'supabase', '.temp', 'project-ref'),
        'utf8',
      )
    ).trim();
  } catch {
    throw new Error('Supabase project is not linked');
  }
  if (ref !== target.projectRef)
    throw new Error('Linked Supabase project does not match target');
}
async function invoke(
  target: SupabaseTarget,
  command: string,
  args: string[],
  stdin?: string,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const result = await (target.runner ?? runProcess)({
    command,
    args,
    cwd: target.workdir,
    env: { ...process.env, ...target.env, ...env },
    stdin,
  });
  if (result.exitCode !== 0)
    throw new Error(`Provider command failed (exit ${result.exitCode})`);
  return result;
}

export async function dryRunDatabasePush(
  target: SupabaseTarget,
): Promise<MigrationDryRun> {
  await linked(target);
  const result = await invoke(target, target.cli ?? 'supabase', [
    'db',
    'push',
    target.local ? '--local' : '--linked',
    '--dry-run',
  ]);
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (/Skipping migrations because it is disabled/.test(output))
    throw new Error('Supabase migrations are disabled');
  if (/Remote database is up to date\./.test(output))
    return { pending: [], upToDate: true };
  const section = output.match(
    /Would push these migrations:\s*([\s\S]*?)(?:\n(?:Finished |Would seed|Would create|A new version of Supabase CLI is available:)|$)/,
  );
  if (!section)
    throw new Error('Unrecognized Supabase migration dry-run output');
  const lines = section[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    !lines.length ||
    lines.some((line) => !/^[•*]\s+\d+_[^/\\\r\n]+\.sql$/.test(line))
  )
    throw new Error('Unrecognized Supabase migration list');
  return {
    pending: lines.map((line) => line.replace(/^[•*]\s+/, '')),
    upToDate: false,
  };
}

export async function executeDatabasePush(
  target: SupabaseTarget,
): Promise<void> {
  await linked(target);
  await invoke(target, target.cli ?? 'supabase', [
    'db',
    'push',
    target.local ? '--local' : '--linked',
    '--yes',
  ]);
}
export async function verifyDatabasePush(
  target: SupabaseTarget,
): Promise<boolean> {
  return (await dryRunDatabasePush(target)).upToDate;
}

export interface SqlCheck {
  connectionEnv: string;
  host: string;
  database: string;
  sql: string;
  expected: string;
  psql?: string;
}
export async function runReadOnlySqlCheck(
  target: SupabaseTarget,
  check: SqlCheck,
): Promise<boolean> {
  if (!target.local) validRef(target.projectRef);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(check.connectionEnv))
    throw new Error('Invalid credential reference');
  const value = (target.env ?? process.env)[check.connectionEnv];
  if (!value) throw new Error('Missing read-only database credential');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Invalid read-only database credential');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.host !== check.host ||
    url.search ||
    url.hash ||
    decodeURIComponent(url.pathname.slice(1)) !== check.database ||
    !check.host ||
    !check.database
  )
    throw new Error('Read-only database target mismatch');
  if (!/^\s*select\b/i.test(check.sql) || /[;\\]/.test(check.sql))
    throw new Error('SQL check must be a single SELECT statement');
  const result = await invoke(
    target,
    check.psql ?? 'psql',
    ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'],
    `BEGIN READ ONLY;\n${check.sql};\nROLLBACK;\n`,
    { PGDATABASE: value, PGOPTIONS: '-c default_transaction_read_only=on' },
  );
  return result.stdout.trim() === check.expected;
}

export async function deployFunction(
  target: SupabaseTarget,
  name: string,
): Promise<void> {
  validRef(target.projectRef);
  validName(name);
  await invoke(target, target.cli ?? 'supabase', [
    'functions',
    'deploy',
    name,
    '--project-ref',
    target.projectRef,
    '--yes',
  ]);
}
export async function setSecretReferences(
  target: SupabaseTarget,
  references: Record<string, string>,
): Promise<void> {
  validRef(target.projectRef);
  const entries = Object.entries(references);
  if (!entries.length) throw new Error('No secret references provided');
  const env = target.env ?? process.env;
  const lines = entries.map(([name, reference]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || name.startsWith('SUPABASE_'))
      throw new Error('Invalid secret name');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference))
      throw new Error('Invalid secret environment reference');
    const value = env[reference];
    if (value === undefined || /[\r\n\0]/.test(value))
      throw new Error('Missing or invalid referenced secret');
    return `${name}="${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$')}"`;
  });
  // The CLI accepts an env file, not stdin. Never place secret values in arguments.
  const dir = await mkdtemp(join(tmpdir(), 'release-gate-'));
  try {
    const file = join(dir, 'secrets.env');
    await writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600, flag: 'wx' });
    await invoke(
      { ...target, workdir: dir },
      target.cli ?? 'supabase',
      [
        'secrets',
        'set',
        '--project-ref',
        target.projectRef,
        '--env-file',
        file,
        '--workdir',
        dir,
      ],
      undefined,
      { SUPABASE_WORKDIR: dir },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function createSupabaseProvider(
  target: SupabaseTarget,
  targetId: string,
  checks: Readonly<Record<string, SqlCheck>> = {},
): Provider {
  async function snapshotKey(): Promise<Buffer> {
    if (!target.snapshotKeyFile)
      throw new Error('A protected snapshot key file is required');
    try {
      await writeFile(target.snapshotKeyFile, randomBytes(32), {
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new Error('Cannot initialize protected snapshot key');
    }
    const key = await readFile(target.snapshotKeyFile);
    if (key.length !== 32) throw new Error('Invalid protected snapshot key');
    return key;
  }
  function functionName(plan: Plan): string {
    if (typeof plan.function !== 'string')
      throw new Error('Function name required');
    validName(plan.function);
    return plan.function;
  }
  function references(plan: Plan): Record<string, string> {
    const refs = plan.references;
    if (!refs || typeof refs !== 'object' || Array.isArray(refs))
      throw new Error('Secret references required');
    const result: Record<string, string> = {};
    for (const [name, ref] of Object.entries(refs)) {
      if (
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        name.startsWith('SUPABASE_') ||
        typeof ref !== 'string' ||
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)
      )
        throw new Error('Invalid secret reference');
      if ((target.env ?? process.env)[ref] === undefined)
        throw new Error('Missing referenced secret');
      result[name] = ref;
    }
    if (!Object.keys(result).length)
      throw new Error('Secret references required');
    return result;
  }
  async function remoteList(
    kind: 'functions' | 'secrets',
  ): Promise<Record<string, unknown>[]> {
    const output = await invoke(target, target.cli ?? 'supabase', [
      kind,
      'list',
      '--project-ref',
      target.projectRef,
      '--output',
      'json',
    ]);
    let data: unknown;
    try {
      data = JSON.parse(output.stdout);
    } catch {
      throw new Error('Unrecognized provider list output');
    }
    if (
      !Array.isArray(data) ||
      data.some(
        (item) => !item || typeof item !== 'object' || Array.isArray(item),
      )
    )
      throw new Error('Unrecognized provider list output');
    return data as Record<string, unknown>[];
  }
  async function tree(dir: string, key: Buffer, prefix = ''): Promise<Json[]> {
    const result: Json[] = [];
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!prefix && (entry.name === '.git' || entry.name === '.android-kit'))
        continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink())
        throw new Error('Cannot snapshot symbolic links in function workspace');
      if (entry.isDirectory())
        result.push(...(await tree(join(dir, entry.name), key, relative)));
      else if (entry.isFile())
        result.push({
          path: relative,
          digest: createHmac('sha256', key)
            .update(await readFile(join(dir, entry.name)))
            .digest('hex'),
        });
      else
        throw new Error('Cannot snapshot special files in function workspace');
    }
    return result;
  }
  function validate(plan: Plan): void {
    if (
      plan.provider !== 'supabase' ||
      plan.target !== targetId ||
      (!target.local && targetId !== target.projectRef)
    )
      throw new Error('Supabase plan target mismatch');
    if (
      !['db-push', 'sql-check', 'function-deploy', 'secrets-set'].includes(
        plan.operation,
      )
    )
      throw new Error('Unsupported Supabase operation');
    if (plan.operation !== 'sql-check' && plan.policy.mode === 'read')
      throw new Error('Supabase write requires write policy');
    if (
      target.local &&
      (plan.operation === 'function-deploy' || plan.operation === 'secrets-set')
    )
      throw new Error('Operation requires a hosted project');
    if (plan.operation === 'sql-check' && plan.policy.mode !== 'read')
      throw new Error('SQL check requires read policy');
  }
  function check(plan: Plan): SqlCheck {
    if (typeof plan.check !== 'string' || !Object.hasOwn(checks, plan.check))
      throw new Error('Unknown SQL check');
    return checks[plan.check];
  }
  async function snapshot(plan: Plan): Promise<Json> {
    validate(plan);
    if (plan.operation === 'sql-check') {
      const item = check(plan);
      return {
        check: plan.check as string,
        host: item.host,
        database: item.database,
        sql: item.sql,
        expected: item.expected,
      };
    }
    if (plan.operation === 'function-deploy') {
      const name = functionName(plan);
      const list = await remoteList('functions');
      const found = list.find((item) => item.slug === name);
      if (
        found &&
        (typeof found.version !== 'number' || typeof found.status !== 'string')
      )
        throw new Error('Unrecognized function metadata');
      return {
        function: name,
        remote: found
          ? { version: found.version as number, status: found.status as string }
          : null,
        workspace: await tree(target.workdir, await snapshotKey()),
        limitation:
          'No provider dry run; external dependencies and deployed content cannot be verified.',
      };
    }
    if (plan.operation === 'secrets-set') {
      const key = await snapshotKey();
      const refs = references(plan);
      const list = await remoteList('secrets');
      const remote = Object.keys(refs)
        .sort()
        .map((name) => {
          const found = list.find((item) => item.name === name);
          if (found && typeof found.value !== 'string')
            throw new Error('Unrecognized secret metadata');
          return {
            name,
            digest: found
              ? createHmac('sha256', key)
                  .update(found.value as string)
                  .digest('hex')
              : null,
          };
        });
      const inputs = Object.entries(refs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, ref]) => {
          const value = (target.env ?? process.env)[ref];
          if (value === undefined) throw new Error('Missing referenced secret');
          return {
            name,
            ref,
            digest: createHmac('sha256', key).update(value).digest('hex'),
          };
        });
      return {
        inputs,
        remote,
        limitation:
          'No provider dry run; secret contents cannot be independently verified.',
      };
    }
    const result = await dryRunDatabasePush(target);
    const migrations = await Promise.all(
      result.pending.map(async (name) => ({
        name,
        sha256: createHash('sha256')
          .update(
            await readFile(
              join(target.workdir, 'supabase', 'migrations', name),
            ),
          )
          .digest('hex'),
      })),
    );
    return { migrations, upToDate: result.upToDate };
  }
  return {
    inspect: snapshot,
    dryRun: snapshot,
    async execute(plan): Promise<Json> {
      validate(plan);
      if (plan.operation === 'sql-check')
        return { passed: await runReadOnlySqlCheck(target, check(plan)) };
      if (plan.operation === 'function-deploy') {
        await deployFunction(target, functionName(plan));
        return { executed: true };
      }
      if (plan.operation === 'secrets-set') {
        await setSecretReferences(target, references(plan));
        return { executed: true };
      }
      await executeDatabasePush(target);
      return { executed: true };
    },
    async verify(plan): Promise<Json> {
      validate(plan);
      if (plan.operation === 'sql-check')
        return { passed: await runReadOnlySqlCheck(target, check(plan)) };
      if (plan.operation === 'function-deploy') {
        const item = (await remoteList('functions')).find(
          (entry) => entry.slug === functionName(plan),
        );
        if (
          !item ||
          typeof item.version !== 'number' ||
          typeof item.status !== 'string'
        )
          return { observed: false, contentVerified: false };
        return {
          observed: true,
          version: item.version,
          status: item.status,
          contentVerified: false,
        };
      }
      if (plan.operation === 'secrets-set') {
        const names = Object.keys(references(plan)).sort();
        const list = await remoteList('secrets');
        return {
          observedNames: names.filter((name) =>
            list.some((entry) => entry.name === name),
          ),
          contentVerified: false,
        };
      }
      return { passed: await verifyDatabasePush(target) };
    },
    async reconcile(plan) {
      validate(plan);
      return {
        status: 'unresolved',
        evidence: {
          reason:
            'A command outcome cannot be established from the current provider state alone.',
        },
      };
    },
  };
}
