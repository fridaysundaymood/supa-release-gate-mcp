#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadReleaseConfig } from '../core/config.js';
import { type Operation, ReleaseInterfaces } from '../core/interfaces.js';
import { resolveProvider } from '../core/providers.js';

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
export function createServer(api: ReleaseInterfaces): McpServer {
  const server = new McpServer({ name: 'release-gate', version: '1.0.0' });
  for (const [name, operation] of Object.entries(tools)) {
    const schema: z.ZodRawShape =
      operation === 'plan'
        ? { plan: z.record(z.unknown()) }
        : [
              'dry-run',
              'approval-status',
              'execute',
              'verify',
              'recover',
            ].includes(operation)
          ? { planHash: z.string() }
          : {};
    server.tool(name, schema, async (args) => {
      const result = await api.invoke(
        operation,
        args as Record<string, unknown>,
      );
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        isError: result.status !== 'pass',
      };
    });
  }
  return server;
}
export async function main(configPath = 'android-kit.yaml'): Promise<void> {
  const config = await loadReleaseConfig(configPath);
  const api = new ReleaseInterfaces(config, (plan) =>
    resolveProvider(config, plan),
  );
  await createServer(api).connect(new StdioServerTransport());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv[2]).catch((error) => {
    console.error(error);
    process.exitCode = 2;
  });
