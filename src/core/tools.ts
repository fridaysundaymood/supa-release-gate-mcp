import { createResult, newRunId, type Result } from '@android-kit/schema';
import { loadReleaseConfig, releaseConfigSchema } from './config.js';
import { type Operation, ReleaseInterfaces } from './interfaces.js';
import { resolveProvider } from './providers.js';

export const configSection = 'releaseGate';
export const configSectionSchema = releaseConfigSchema;
export const supportedSchemaMajors = [1];

export const tools: Record<string, Operation> = {
  release_plan_change: 'plan',
  release_dry_run: 'dry-run',
  release_approval_status: 'approval-status',
  release_execute: 'execute',
  release_verify: 'verify',
  release_recover: 'recover',
  release_ledger_list: 'ledger-list',
  release_ledger_render: 'ledger-render',
  release_status: 'status',
  release_doctor: 'doctor',
};

export interface ToolOptions {
  configPath?: string;
  api?: ReleaseInterfaces;
}

export function toolDefinitions(options: ToolOptions = {}) {
  let apiPromise: Promise<ReleaseInterfaces> | undefined;
  const getApi = () => {
    if (options.api) return Promise.resolve(options.api);
    apiPromise ??= loadReleaseConfig(
      options.configPath ?? 'android-kit.yaml',
    ).then(
      (config) =>
        new ReleaseInterfaces(config, (plan) => resolveProvider(config, plan)),
    );
    return apiPromise;
  };
  return Object.entries(tools).map(([name, operation]) => {
    const properties =
      operation === 'plan'
        ? { plan: { type: 'object', additionalProperties: true } }
        : [
              'dry-run',
              'approval-status',
              'execute',
              'verify',
              'recover',
            ].includes(operation)
          ? { planHash: { type: 'string' } }
          : {};
    const required = Object.keys(properties);
    return {
      name,
      description: `Release gate ${operation}`,
      inputSchema: {
        type: 'object' as const,
        properties,
        required,
        additionalProperties: false,
      },
      handler: async (input: Record<string, unknown> = {}): Promise<Result> => {
        const startedAt = new Date();
        try {
          return await (await getApi()).invoke(operation, input);
        } catch (error) {
          apiPromise = undefined;
          return createResult({
            tool: 'release',
            operation,
            run_id: newRunId(),
            status: 'error',
            classification: 'config',
            summary: error instanceof Error ? error.message : String(error),
            evidence: [],
            artifacts: [],
            startedAt,
          });
        }
      },
    };
  });
}

export async function doctor(options: ToolOptions = {}): Promise<Result> {
  const tool = toolDefinitions(options).find(
    (definition) => definition.name === 'release_doctor',
  );
  if (!tool) throw new Error('Doctor tool missing');
  return tool.handler({});
}
