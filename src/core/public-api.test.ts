import { describe, expect, it, vi } from 'vitest';

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => {
  throw new Error('Root import must not load the stdio transport');
});

describe('public API', () => {
  // Import after installing the mock to exercise the module-loading boundary.
  it('imports without starting a transport and exposes the MCP tools', async () => {
    const api = await import('./index.js');
    expect(api.configSection).toBe('releaseGate');
    expect(api.supportedSchemaMajors).toEqual([1]);
    expect(api.toolDefinitions().map((tool) => tool.name)).not.toContain(
      'release_approve',
    );
    expect(typeof api.doctor).toBe('function');
  });
});
