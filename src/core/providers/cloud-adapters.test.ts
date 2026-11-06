import { describe, expect, it } from 'vitest';
import {
  applyDnsChange,
  diffDnsRecord,
  listDnsRecords,
  verifyPages,
} from './cloudflare.js';
import { diffIamPolicies, readIamPolicy } from './gcp.js';

// Synthetic HTTP recordings; no provider credentials or network access are needed.
describe('Cloudflare API', () => {
  it('reads every DNS page and sends the approved update', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      {
        success: true,
        result: [
          { id: 'one', type: 'A', name: 'example.test', content: '192.0.2.1' },
        ],
        result_info: { total_pages: 2 },
      },
      {
        success: true,
        result: [
          { id: 'two', type: 'TXT', name: 'example.test', content: 'test' },
        ],
        result_info: { total_pages: 2 },
      },
      {
        success: true,
        result: {
          id: 'one',
          type: 'A',
          name: 'example.test',
          content: '192.0.2.2',
        },
      },
    ];
    const fetcher: typeof fetch = async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(responses.shift());
    };
    const auth = { token: 'synthetic', fetch: fetcher };
    const records = await listDnsRecords(auth, 'zone');
    expect(records).toHaveLength(2);
    const change = diffDnsRecord(records[0] ?? null, {
      type: 'A',
      name: 'example.test',
      content: '192.0.2.2',
    });
    await applyDnsChange(auth, 'zone', change);
    expect(requests[2]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual(change.after);
    expect(requests[1]?.url).toContain('page=2');
  });
  it('fails on a rejected provider response and verifies actual content', async () => {
    const failed: typeof fetch = async () =>
      Response.json(
        { success: false, errors: [{ message: 'denied' }] },
        { status: 403 },
      );
    await expect(
      listDnsRecords({ token: 'synthetic', fetch: failed }, 'zone'),
    ).rejects.toThrow('403');
    expect(
      (
        await verifyPages(
          'https://example.test',
          'expected',
          async () => new Response('other'),
        )
      ).matched,
    ).toBe(false);
  });
});

describe('GCP IAM API', () => {
  it('requests conditional bindings and compares policies without treating member order as a change', async () => {
    let request: RequestInit | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      request = init;
      return Response.json({
        version: 3,
        etag: 'abc',
        bindings: [
          {
            role: 'roles/viewer',
            members: ['user:a@example.test', 'user:b@example.test'],
          },
        ],
      });
    };
    const before = await readIamPolicy(
      { token: 'synthetic', fetch: fetcher },
      'sample-project',
    );
    expect(JSON.parse(String(request?.body))).toEqual({
      options: { requestedPolicyVersion: 3 },
    });
    expect(
      diffIamPolicies(before, {
        ...before,
        bindings: [
          {
            role: 'roles/viewer',
            members: ['user:b@example.test', 'user:a@example.test'],
          },
        ],
      }).changed,
    ).toBe(false);
    expect(
      diffIamPolicies(before, { ...before, bindings: [] }).removed,
    ).toHaveLength(1);
  });
  it('propagates a provider denial', async () => {
    await expect(
      readIamPolicy(
        {
          token: 'synthetic',
          fetch: async () =>
            Response.json({ error: { message: 'denied' } }, { status: 403 }),
        },
        'sample-project',
      ),
    ).rejects.toThrow('denied');
  });
});
