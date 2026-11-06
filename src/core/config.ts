import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '@android-kit/schema';

export interface ReleaseConfig {
  projectRoot?: string;
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
    mode: 'read' | 'write' | 'separate-approval';
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
          mode: { enum: ['read', 'write', 'separate-approval'] },
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
              ].map((key) => [key, { type: 'string' }]),
            ),
          },
        ]),
      ),
    },
  },
} as const;

export async function loadReleaseConfig(path: string): Promise<ReleaseConfig> {
  const config = await loadConfig<ReleaseConfig>(path, {
    name: 'releaseGate',
    schema: releaseConfigSchema,
  });
  if (!config) throw new Error('Missing releaseGate configuration');
  const base = dirname(resolve(path));
  const trustedPublicKeys = config.trustedApproversFile
    ? (JSON.parse(
        await readFile(resolve(base, config.trustedApproversFile), 'utf8'),
      ) as Record<string, string>)
    : config.trustedPublicKeys;
  return {
    ...config,
    trustedPublicKeys,
    projectRoot: base,
    directory: resolve(base, config.directory),
    approvalDirectory: resolve(base, config.approvalDirectory),
  };
}
