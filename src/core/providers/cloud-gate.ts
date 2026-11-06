import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { canonicalJson, type Json, type Plan, type Provider } from '../gate.js';
import {
  applyDnsChange,
  type CloudflareAuth,
  type DnsRecord,
  deployPages,
  diffDnsRecord,
  listDnsRecords,
  verifyPages,
} from './cloudflare.js';
import {
  diffIamPolicies,
  type GcpAuth,
  type IamPolicy,
  readIamPolicy,
} from './gcp.js';

const exec = promisify(execFile);
const asJson = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected plan arguments object');
  return value as Record<string, unknown>;
};
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value)
    throw new Error(`${name} is required`);
  return value;
};
const args = (plan: Plan) => object(plan.args);

async function directoryState(directory: string): Promise<Json> {
  const cwd = resolve(directory);
  const status = await exec(
    'git',
    ['status', '--porcelain', '--ignored', '--untracked-files=all', '--', '.'],
    { cwd },
  );
  if (status.stdout.trim())
    throw new Error(
      'Pages directory contains uncommitted, untracked, or ignored files',
    );
  const files = await exec('git', ['ls-files', '-z', '--', '.'], {
    cwd,
    encoding: 'buffer',
  });
  const names = files.stdout
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  if (!names.length) throw new Error('Pages directory has no tracked files');
  const commit = (
    await exec('git', ['rev-parse', 'HEAD'], { cwd })
  ).stdout.trim();
  const hashes: Record<string, string> = {};
  for (const name of names) {
    const path = resolve(cwd, name);
    if (!(await lstat(path)).isFile())
      throw new Error(`Pages entry is not a regular file: ${name}`);
    hashes[name] = createHash('sha256')
      .update(await readFile(path))
      .digest('hex');
  }
  return { commit, files: hashes };
}

export function createCloudflareGateProvider(
  settings: CloudflareAuth & {
    accountId: string;
    zoneId?: string;
    wrangler?: string;
  },
): Provider {
  const deployments = async (
    project: string,
  ): Promise<
    Array<{
      id: string;
      url: string;
      aliases?: string[];
      deployment_trigger?: { metadata?: { commit_hash?: string } };
    }>
  > => {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(settings.accountId)}/pages/projects/${encodeURIComponent(project)}/deployments?per_page=25`;
    const response = await (settings.fetch ?? fetch)(url, {
      headers: { Authorization: `Bearer ${settings.token}` },
    });
    const body = (await response.json()) as {
      success?: boolean;
      result?: Array<{
        id: string;
        url: string;
        aliases?: string[];
        deployment_trigger?: { metadata?: { commit_hash?: string } };
      }>;
      errors?: unknown;
    };
    if (!response.ok || body.success !== true || !Array.isArray(body.result))
      throw new Error(
        `Cloudflare deployments API failed (${response.status}): ${JSON.stringify(body.errors ?? [])}`,
      );
    return body.result;
  };
  const dns = async (plan: Plan) => {
    if (!settings.zoneId || plan.target !== settings.zoneId)
      throw new Error('DNS target must match configured zone');
    const input = args(plan);
    const after = input.after === null ? null : object(input.after);
    const id =
      input.recordId === undefined ? null : text(input.recordId, 'recordId');
    const records = await listDnsRecords(settings, settings.zoneId);
    const before = id ? records.find((record) => record.id === id) : null;
    if (id && !before) throw new Error('DNS record not found');
    return {
      records: records.sort((a, b) => a.id.localeCompare(b.id)),
      change: diffDnsRecord(before ?? null, after),
    };
  };
  const pages = (plan: Plan) => {
    const input = args(plan);
    const directory = text(input.directory, 'directory');
    const url = text(input.url, 'url');
    const expectedContent = text(input.expectedContent, 'expectedContent');
    const branch =
      input.branch === undefined ? undefined : text(input.branch, 'branch');
    return { directory, url, expectedContent, branch };
  };
  const inspect = async (plan: Plan): Promise<Json> => {
    if (plan.operation === 'dns-change')
      return asJson((await dns(plan)).records);
    if (plan.operation === 'pages-deploy')
      return asJson({
        directory: await directoryState(pages(plan).directory),
        deployments: await deployments(plan.target),
      });
    throw new Error(`Unsupported Cloudflare operation: ${plan.operation}`);
  };
  const verify = async (plan: Plan): Promise<Json> => {
    if (plan.operation === 'pages-deploy') {
      const input = pages(plan);
      const state = object(await directoryState(input.directory));
      const deployment = (await deployments(plan.target)).find(
        (item) =>
          item.deployment_trigger?.metadata?.commit_hash === state.commit &&
          (item.url === input.url || item.aliases?.includes(input.url)),
      );
      if (!deployment)
        throw new Error(
          'No Pages deployment matches the committed directory and verification URL',
        );
      const result = await verifyPages(
        input.url,
        input.expectedContent,
        settings.fetch,
      );
      if (!result.matched) throw new Error('Pages content verification failed');
      return asJson({
        ...result,
        deploymentId: deployment.id,
        commit: state.commit,
      });
    }
    if (plan.operation === 'dns-change') {
      if (!settings.zoneId || plan.target !== settings.zoneId)
        throw new Error('DNS target must match configured zone');
      const input = args(plan);
      const after = input.after === null ? null : object(input.after);
      const id =
        input.recordId === undefined ? null : text(input.recordId, 'recordId');
      const records = await listDnsRecords(settings, settings.zoneId);
      const matches = (record: DnsRecord, desired: Record<string, unknown>) =>
        Object.entries(desired).every(
          ([key, value]) =>
            record[key] !== undefined &&
            canonicalJson(record[key]) === canonicalJson(value),
        );
      const found = id
        ? records.filter((record) => record.id === id)
        : records.filter((record) => after && matches(record, after));
      const matched =
        after === null
          ? found.length === 0
          : found.length === 1 &&
            found.some((record) => matches(record, after));
      if (!matched) throw new Error('DNS verification failed');
      return asJson({ matched, records: found });
    }
    throw new Error(`Unsupported Cloudflare operation: ${plan.operation}`);
  };
  return {
    inspect,
    dryRun: async (plan) => {
      if (plan.operation === 'dns-change')
        return asJson({
          ...(await dns(plan)).change,
          limitation:
            'No provider dry run or conditional write; external changes may race execution.',
        });
      if (plan.operation === 'pages-deploy')
        return asJson({
          directory: pages(plan).directory,
          state: await directoryState(pages(plan).directory),
          limitation:
            'Wrangler has no deployment dry run; execution uploads and publishes. External changes may race execution.',
        });
      throw new Error(`Unsupported Cloudflare operation: ${plan.operation}`);
    },
    execute: async (plan) => {
      if (plan.operation === 'dns-change') {
        if (!settings.zoneId) throw new Error('DNS zone is not configured');
        return asJson(
          await applyDnsChange(
            settings,
            settings.zoneId,
            (await dns(plan)).change,
          ),
        );
      }
      if (plan.operation === 'pages-deploy') {
        const input = pages(plan);
        return asJson(
          await deployPages({
            directory: input.directory,
            project: plan.target,
            accountId: settings.accountId,
            token: settings.token,
            branch: input.branch,
            wrangler: settings.wrangler,
          }),
        );
      }
      throw new Error(`Unsupported Cloudflare operation: ${plan.operation}`);
    },
    verify,
    reconcile: async () => ({
      status: 'unresolved',
      evidence:
        'Provider state alone cannot establish which execution caused it; manual reconciliation required.',
    }),
  };
}

export function createGcpGateProvider(auth: GcpAuth): Provider {
  const read = async (plan: Plan) => {
    if (plan.operation !== 'iam-read' && plan.operation !== 'iam-diff')
      throw new Error(`Unsupported GCP operation: ${plan.operation}`);
    return readIamPolicy(auth, plan.target);
  };
  const evidence = async (plan: Plan): Promise<Json> => {
    const before = await read(plan);
    return plan.operation === 'iam-read'
      ? asJson(before)
      : asJson(diffIamPolicies(before, object(args(plan).after) as IamPolicy));
  };
  return {
    inspect: async (plan) => asJson(await read(plan)),
    dryRun: evidence,
    execute: evidence,
    verify: evidence,
    reconcile: async (plan) => ({
      status: 'succeeded',
      evidence: await evidence(plan),
    }),
  };
}
