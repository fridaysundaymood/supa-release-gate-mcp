#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadReleaseConfig } from '../core/config.js';
import { ReleaseInterfaces } from '../core/interfaces.js';
import { resolveProvider } from '../core/providers.js';
import { toolDefinitions } from '../core/tools.js';

export { tools } from '../core/tools.js';

export function createServer(api: ReleaseInterfaces): McpServer {
  const server = new McpServer({ name: 'release-gate', version: '1.0.0' });
  for (const tool of toolDefinitions({ api })) {
    const schema: z.ZodRawShape = {};
    for (const [key, property] of Object.entries(tool.inputSchema.properties)) {
      schema[key] =
        property.type === 'string' ? z.string() : z.record(z.unknown());
    }
    server.tool(tool.name, tool.description, schema, async (args) => {
      const result = await tool.handler(args);
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
