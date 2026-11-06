import { spawn } from 'node:child_process';
import type { Approval, Json, Plan } from './gate.js';

export async function externalExecute(
  executable: string,
  plan: Plan,
  approval: Approval,
): Promise<Json> {
  const child = spawn(executable, [], {
    shell: false,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  child.once('error', reject);
  child.once('close', (code) =>
    code === 0
      ? resolve()
      : reject(new Error(`External executor failed (${code})`)),
  );
  child.stdin.end(JSON.stringify({ plan, approval }));
  await promise;
  return JSON.parse(stdout) as Json;
}
