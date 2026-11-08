import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { checkReleaseHost, type ReleaseConfig } from './config.js';

const exec = promisify(execFile);

export interface DoctorResult {
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}
export async function doctor(config: ReleaseConfig): Promise<DoctorResult> {
  const checks = [
    {
      name: 'node',
      ok: Number(process.versions.node.split('.')[0]) === 24,
      detail: `Node ${process.version}; install Node 24 if incompatible`,
    },
  ];
  try {
    await checkReleaseHost(config);
    checks.push({
      name: 'host trust boundary',
      ok: true,
      detail: 'Host paths are protected and outside the project',
    });
  } catch (error) {
    checks.push({
      name: 'host trust boundary',
      ok: false,
      detail:
        error instanceof Error
          ? error.message
          : 'Host path protection check failed',
    });
  }
  for (const [name, options] of Object.entries(config.providers ?? {})) {
    if (name === 'supabase' || name === 'cloudflare') {
      const command =
        name === 'supabase'
          ? (options.cli ?? 'supabase')
          : (options.wrangler ?? 'wrangler');
      try {
        const result = await exec(command, ['--version'], { timeout: 10000 });
        const version = result.stdout.trim();
        const ok = name !== 'supabase' || /\b2\.75\.0\b/.test(version);
        checks.push({
          name: command,
          ok,
          detail: ok
            ? version
            : `Found ${version}; install Supabase CLI 2.75.0`,
        });
      } catch {
        checks.push({
          name: command,
          ok: false,
          detail: `Install ${name === 'supabase' ? 'Supabase CLI 2.75.0' : 'Wrangler'} and put it on PATH`,
        });
      }
    }
    if (options.accessTokenEnv)
      checks.push({
        name: `${name} credential`,
        ok: !!process.env[options.accessTokenEnv],
        detail: process.env[options.accessTokenEnv]
          ? 'Credential reference is populated'
          : `Set environment variable ${options.accessTokenEnv}`,
      });
  }
  return { checks };
}
