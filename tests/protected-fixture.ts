import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

export function protectFixtureDirectory(path: string): void {
  if (process.platform !== 'win32') return;
  if (!process.env.SystemRoot) throw new Error('SystemRoot is required');
  const system32 = resolve(process.env.SystemRoot, 'System32');
  const identity = execFileSync(
    resolve(system32, 'whoami.exe'),
    ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8' },
  );
  const sid = identity.match(/S-1-(?:\d+-)*\d+/)?.[0];
  if (!sid) throw new Error('Cannot determine fixture owner SID');
  execFileSync(resolve(system32, 'icacls.exe'), [
    path,
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
  ]);
}
