import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const cwd = resolve(import.meta.dirname, '..');
const cli = resolve(
  cwd,
  'node_modules/supabase/bin',
  process.platform === 'win32' ? 'supabase.exe' : 'supabase',
);
const workdir = resolve(cwd, 'test/fixtures/local');
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}
let status = 1;
let started = false;
if (run(cli, ['status', '--workdir', workdir]) === 0) {
  throw new Error(
    'Local Supabase stack is already running; refusing to stop it',
  );
}
try {
  if (
    run(cli, [
      'start',
      '--workdir',
      workdir,
      '-x',
      'studio,imgproxy,edge-runtime,logflare,vector,supavisor,realtime,storage-api,gotrue,kong,mailpit,postgrest,postgres-meta',
    ]) === 0
  ) {
    started = true;
    status = run(
      process.execPath,
      [
        resolve(cwd, 'node_modules/vitest/vitest.mjs'),
        'run',
        'src/core/local-supabase.integration.test.ts',
      ],
      { ...process.env, RELEASE_GATE_LOCAL_INTEGRATION: '1' },
    );
  }
} finally {
  if (started && run(cli, ['stop', '--workdir', workdir, '--no-backup']) !== 0)
    status = 1;
}
process.exitCode = status;
