import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const api = 'https://api.cloudflare.com/client/v4';
export type CloudflareAuth = { token: string; fetch?: typeof fetch };
export type DnsRecord = {
  id: string;
  type: string;
  name: string;
  content?: string;
  ttl?: number;
  proxied?: boolean;
  [key: string]: unknown;
};
export type DnsChange = {
  before: DnsRecord | null;
  after: Record<string, unknown> | null;
};

async function request<T>(
  auth: CloudflareAuth,
  path: string,
  init: RequestInit = {},
): Promise<{ result: T; result_info?: { total_pages?: number } }> {
  const response = await (auth.fetch ?? fetch)(`${api}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${auth.token}`, ...init.headers },
  });
  const body = (await response.json()) as {
    success?: boolean;
    result?: T;
    result_info?: { total_pages?: number };
    errors?: unknown;
  };
  if (!response.ok || body.success !== true || body.result === undefined)
    throw new Error(
      `Cloudflare API failed (${response.status}): ${JSON.stringify(body.errors ?? [])}`,
    );
  return { result: body.result, result_info: body.result_info };
}

export async function listDnsRecords(
  auth: CloudflareAuth,
  zoneId: string,
): Promise<DnsRecord[]> {
  const records: DnsRecord[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const result = await request<DnsRecord[]>(
      auth,
      `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result.result))
      throw new Error('Invalid Cloudflare DNS response');
    records.push(...result.result);
    totalPages = result.result_info?.total_pages ?? 1;
    page++;
  } while (page <= totalPages);
  return records;
}

/** Compare an explicit intended record with its current provider state; null means create/delete. */
export function diffDnsRecord(
  before: DnsRecord | null,
  after: Record<string, unknown> | null,
): DnsChange {
  if (!before && !after)
    throw new Error('A DNS change must create, update, or delete a record');
  return { before, after };
}

/** Execute only after the caller has approved the exact change and rechecked provider state. */
export async function applyDnsChange(
  auth: CloudflareAuth,
  zoneId: string,
  change: DnsChange,
): Promise<unknown> {
  const base = `/zones/${encodeURIComponent(zoneId)}/dns_records`;
  const path = change.before
    ? `${base}/${encodeURIComponent(change.before.id)}`
    : base;
  const method = !change.before ? 'POST' : !change.after ? 'DELETE' : 'PUT';
  const init: RequestInit = { method };
  if (change.after) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(change.after);
  }
  return (await request<unknown>(auth, path, init)).result;
}

export type PagesDeployOptions = {
  directory: string;
  project: string;
  accountId: string;
  token: string;
  branch?: string;
  wrangler?: string;
};
/** Deploy a clean, tracked directory with Wrangler's Direct Upload implementation. */
export async function deployPages(
  options: PagesDeployOptions,
): Promise<{ stdout: string; stderr: string; commit: string }> {
  const cwd = options.directory;
  const status = await exec(
    'git',
    ['status', '--porcelain', '--ignored', '--untracked-files=all', '--', '.'],
    { cwd },
  );
  if (status.stdout.trim())
    throw new Error(
      'Pages directory contains uncommitted, untracked, or ignored files',
    );
  const tracked = await exec('git', ['ls-files', '--', '.'], { cwd });
  if (!tracked.stdout.trim())
    throw new Error('Pages directory has no tracked files');
  const revision = await exec('git', ['rev-parse', 'HEAD'], { cwd });
  const commit = revision.stdout.trim();
  const args = [
    'pages',
    'deploy',
    '.',
    '--project-name',
    options.project,
    '--commit-hash',
    commit,
    '--commit-dirty=false',
  ];
  if (options.branch) args.push('--branch', options.branch);
  const result = await exec(options.wrangler ?? 'wrangler', args, {
    cwd,
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: options.accountId,
      CLOUDFLARE_API_TOKEN: options.token,
    },
  });
  return { stdout: result.stdout, stderr: result.stderr, commit };
}

export async function verifyPages(
  url: string,
  expectedContent: string,
  fetcher: typeof fetch = fetch,
): Promise<{ url: string; matched: boolean; status: number }> {
  const response = await fetcher(url);
  const text = await response.text();
  return {
    url: response.url || url,
    matched: response.ok && text.includes(expectedContent),
    status: response.status,
  };
}
