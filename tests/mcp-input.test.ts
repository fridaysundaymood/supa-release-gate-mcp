import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { ReleaseInterfaces } from '../src/core/interfaces.js';
import { createServer } from '../src/mcp/index.js';

describe('registered MCP input validation', () => {
  it('rejects unknown, missing and mistyped arguments before dispatch', async () => {
    const invoke = vi.fn(async () => ({ status: 'pass' }));
    const server = createServer({ invoke } as unknown as ReleaseInterfaces);
    const client = new Client({ name: 'input-test', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    try {
      const tools = await client.listTools();
      for (const tool of tools.tools) {
        expect(tool.inputSchema.additionalProperties).toBe(false);
      }
      for (const [name, args] of [
        ['release_status', { unexpected: true }],
        ['release_verify', { planHash: 'a'.repeat(64), unexpected: true }],
        ['release_verify', {}],
        ['release_verify', { planHash: 42 }],
        ['release_plan_change', { plan: 'not an object' }],
      ] as const) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError).toBe(true);
      }
      expect(invoke).not.toHaveBeenCalled();
      const result = await client.callTool({
        name: 'release_status',
        arguments: {},
      });
      expect(result.isError).toBe(false);
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
