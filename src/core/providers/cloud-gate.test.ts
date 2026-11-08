import { describe, expect, it } from 'vitest';
import type { Plan } from '../gate.js';
import {
  createCloudflareGateProvider,
  createGcpGateProvider,
} from './cloud-gate.js';

const plan = (
  provider: string,
  target: string,
  operation: string,
  args: Plan['args'],
): Plan => ({
  provider,
  target,
  operation,
  args,
  policy: { id: 'test', mode: 'write' },
});

describe('cloud gate adapters', () => {
  it('reports DNS before and after and refuses uncertain reconciliation', async () => {
    const fetcher: typeof fetch = async () =>
      Response.json({
        success: true,
        result: [
          {
            id: 'record',
            type: 'A',
            name: 'example.test',
            content: '192.0.2.1',
          },
        ],
        result_info: { total_pages: 1 },
      });
    const provider = createCloudflareGateProvider({
      token: 'synthetic',
      accountId: 'account',
      zoneId: 'zone',
      fetch: fetcher,
    });
    const change = plan('cloudflare', 'zone', 'dns-change', {
      recordId: 'record',
      after: { type: 'A', name: 'example.test', content: '192.0.2.2' },
    });
    expect(await provider.dryRun(change)).toMatchObject({
      before: { id: 'record', content: '192.0.2.1' },
      after: { content: '192.0.2.2' },
    });
    expect((await provider.reconcile(change)).status).toBe('unresolved');
    await expect(provider.verify(change)).rejects.toThrow(
      'verification failed',
    );
  });
  it('reads IAM v3 and reports a proposed binding removal without writing', async () => {
    const methods: string[] = [];
    const fetcher: typeof fetch = async (_url, init) => {
      methods.push(init?.method ?? 'GET');
      return Response.json({
        version: 3,
        bindings: [{ role: 'roles/viewer', members: ['user:a@example.test'] }],
      });
    };
    const provider = createGcpGateProvider({
      token: 'synthetic',
      fetch: fetcher,
    });
    const change = plan('gcp', 'project', 'iam-diff', {
      after: { version: 3, bindings: [] },
    });
    expect(await provider.dryRun(change)).toMatchObject({
      changed: true,
      removed: [{ role: 'roles/viewer' }],
    });
    await provider.execute(change, { state: null, evidence: null });
    expect(methods).toEqual(['POST', 'POST']);
  });
});
