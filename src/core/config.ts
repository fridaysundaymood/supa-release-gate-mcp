import { execFile } from 'node:child_process';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { loadConfig } from '@budaknyenyel/kit-schema';

export interface ReleaseConfig {
  projectRoot?: string;
  hostConfigPath?: string;
  directory: string;
  trustedPublicKeys: Record<string, string>;
  trustedApproversFile?: string;
  approvalDirectory: string;
  supabaseChecks?: Record<
    string,
    {
      connectionEnv: string;
      host: string;
      database: string;
      sql: string;
      expected: string;
      psql?: string;
    }
  >;
  policies: Array<{
    provider: string;
    target: string;
    operation: string;
    id: string;
    mode: 'read' | 'write';
    secretEnvAllowlist?: string[];
  }>;
  externalExecutor?: string;
  providers?: Record<string, Record<string, string>>;
}

export const releaseConfigSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['directory', 'approvalDirectory', 'policies'],
  anyOf: [
    { required: ['trustedPublicKeys'] },
    { required: ['trustedApproversFile'] },
  ],
  properties: {
    directory: { type: 'string', minLength: 1 },
    approvalDirectory: { type: 'string', minLength: 1 },
    trustedPublicKeys: {
      type: 'object',
      additionalProperties: { type: 'string', minLength: 1 },
    },
    trustedApproversFile: { type: 'string', minLength: 1 },
    externalExecutor: { type: 'string', minLength: 1 },
    supabaseChecks: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['connectionEnv', 'host', 'database', 'sql', 'expected'],
        properties: {
          connectionEnv: { type: 'string' },
          host: { type: 'string' },
          database: { type: 'string' },
          sql: { type: 'string' },
          expected: { type: 'string' },
          psql: { type: 'string' },
        },
      },
    },
    policies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['provider', 'target', 'operation', 'id', 'mode'],
        properties: {
          provider: { type: 'string', minLength: 1 },
          target: { type: 'string', minLength: 1 },
          operation: { type: 'string', minLength: 1 },
          id: { type: 'string', minLength: 1 },
          mode: { enum: ['read', 'write'] },
          secretEnvAllowlist: {
            type: 'array',
            items: { type: 'string', minLength: 1 },
          },
        },
      },
    },
    providers: {
      type: 'object',
      additionalProperties: false,
      properties: Object.fromEntries(
        ['supabase', 'play', 'cloudflare', 'gcp'].map((name) => [
          name,
          {
            type: 'object',
            additionalProperties: false,
            properties: Object.fromEntries(
              [
                'projectRef',
                'workdir',
                'cli',
                'local',
                'packageName',
                'accessTokenEnv',
                'accountId',
                'zoneId',
                'wrangler',
                'pagesRoot',
              ].map((key) => [key, { type: 'string' }]),
            ),
          },
        ]),
      ),
    },
  },
} as const;

const exec = promisify(execFile);

export function defaultReleaseConfigPath(): string {
  return (
    process.env.RELEASE_GATE_CONFIG ??
    resolve(
      process.env.APPDATA ??
        process.env.XDG_CONFIG_HOME ??
        resolve(homedir(), '.config'),
      'supa-release-gate',
      'config.yaml',
    )
  );
}

async function existingPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return resolve(
      await existingPath(parent),
      path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
    );
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

async function protectPaths(paths: string[]): Promise<void> {
  const entries = new Map<string, boolean>();
  const pending = paths.map((path) => ({ path: resolve(path), target: true }));
  while (pending.length) {
    const item = pending.pop();
    if (!item) break;
    const { path, target } = item;
    const actual = await realpath(path);
    const previous = entries.get(actual);
    entries.set(actual, target || !!previous);
    if (previous !== undefined) continue;
    for (const parent of new Set([dirname(actual), dirname(path)])) {
      if (parent !== path && parent !== actual)
        pending.push({ path: parent, target: false });
    }
  }
  if (process.platform === 'win32') {
    if (!process.env.SystemRoot)
      throw new Error('SystemRoot is required for Windows ACL checks');
    const script = `$ErrorActionPreference='Stop'; $me=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $trusted=@($me,'S-1-5-18','S-1-5-32-544'); try { $trusted+=([System.Security.Principal.NTAccount]'NT SERVICE\\TrustedInstaller').Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {}; $danger=[System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership; foreach($item in (ConvertFrom-Json $env:RELEASE_GATE_ACL_PATHS)) { $a=Get-Acl -LiteralPath $item.path; $owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value; if ($owner -notin $trusted) { throw "Untrusted owner on $($item.path)" }; $mask=$danger; if($item.target) { $mask=$mask -bor [System.Security.AccessControl.FileSystemRights]::Write }; foreach($r in $a.Access) { if($r.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) { continue }; if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $mask) -ne 0) { $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if($sid -notin $trusted) { throw "Untrusted write access on $($item.path)" } } } }`;
    await exec(
      resolve(
        process.env.SystemRoot,
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe',
      ),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: {
          ...process.env,
          RELEASE_GATE_ACL_PATHS: JSON.stringify(
            Array.from(entries, ([path, target]) => ({ path, target })),
          ),
        },
      },
    );
  } else {
    for (const [actual] of entries) {
      const info = await stat(actual);
      if (
        (typeof process.getuid === 'function' &&
          info.uid !== process.getuid() &&
          info.uid !== 0) ||
        (info.mode & 0o022 &&
          !(info.isDirectory() && info.mode & 0o1000 && info.uid === 0))
      )
        throw new Error(`Release host path is not protected: ${actual}`);
    }
  }
}

async function protectDirectory(path: string): Promise<void> {
  try {
    await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await protectPaths([dirname(path)]);
    await mkdir(path, { mode: 0o700 });
    if (process.platform === 'win32') {
      if (!process.env.SystemRoot)
        throw new Error('SystemRoot is required for Windows ACL setup');
      const system32 = resolve(process.env.SystemRoot, 'System32');
      const identity = await exec(resolve(system32, 'whoami.exe'), [
        '/user',
        '/fo',
        'csv',
        '/nh',
      ]);
      const sid = identity.stdout.match(/S-1-(?:\d+-)*\d+/)?.[0];
      if (!sid)
        throw new Error(
          'Cannot determine Windows account SID for release directory ACL',
        );
      await exec(resolve(system32, 'icacls.exe'), [
        path,
        '/inheritance:r',
        '/grant:r',
        `*${sid}:(OI)(CI)F`,
        '*S-1-5-18:(OI)(CI)F',
        '*S-1-5-32-544:(OI)(CI)F',
      ]);
    }
  }
}

export async function checkReleaseHost(config: ReleaseConfig): Promise<void> {
  if (!config.projectRoot || !config.hostConfigPath)
    throw new Error('Protected host configuration is required');
  const project = await existingPath(resolve(config.projectRoot));
  const executables = [
    config.externalExecutor,
    ...Object.values(config.providers ?? {}).flatMap((provider) => [
      provider.cli,
      provider.wrangler,
    ]),
    ...Object.values(config.supabaseChecks ?? {}).map((check) => check.psql),
  ].filter((value): value is string => !!value);
  const paths = [
    config.hostConfigPath,
    config.directory,
    config.approvalDirectory,
    config.trustedApproversFile,
    ...executables,
  ].filter((value): value is string => !!value);
  if (config.providers?.supabase && !config.providers.supabase.cli)
    throw new Error('Protected absolute Supabase CLI path is required');
  if (config.providers?.cloudflare && !config.providers.cloudflare.wrangler)
    throw new Error('Protected absolute Wrangler path is required');
  if (Object.values(config.supabaseChecks ?? {}).some((check) => !check.psql))
    throw new Error('Protected absolute psql path is required');
  for (const path of paths) {
    if (!isAbsolute(path))
      throw new Error(`Release host path must be absolute: ${path}`);
    if (inside(project, await existingPath(path)))
      throw new Error(`Release host path must be outside the project: ${path}`);
  }
  await protectDirectory(config.directory);
  await protectDirectory(config.approvalDirectory);
  await protectPaths(paths);
}

export async function loadReleaseConfig(
  path = defaultReleaseConfigPath(),
): Promise<ReleaseConfig> {
  const hostConfigPath = resolve(path);
  const base = dirname(hostConfigPath);
  if (
    inside(
      await existingPath(process.cwd()),
      await existingPath(hostConfigPath),
    )
  )
    throw new Error('Release host configuration must be outside the project');
  await protectPaths([hostConfigPath]);
  const config = await loadConfig<ReleaseConfig>(hostConfigPath, {
    name: 'releaseGate',
    schema: releaseConfigSchema,
  });
  if (!config) throw new Error('Missing releaseGate configuration');
  const resolved: ReleaseConfig = {
    ...config,
    hostConfigPath,
    projectRoot: process.cwd(),
    directory: resolve(base, config.directory),
    approvalDirectory: resolve(base, config.approvalDirectory),
    trustedApproversFile: config.trustedApproversFile
      ? resolve(base, config.trustedApproversFile)
      : undefined,
    externalExecutor: config.externalExecutor
      ? resolve(base, config.externalExecutor)
      : undefined,
  };
  await checkReleaseHost(resolved);
  if (resolved.trustedApproversFile)
    resolved.trustedPublicKeys = JSON.parse(
      await readFile(resolved.trustedApproversFile, 'utf8'),
    ) as Record<string, string>;
  return resolved;
}
