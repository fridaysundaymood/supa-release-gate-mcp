import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stdout } from 'node:process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { loadReleaseConfig } from '../src/core/config.js';
import { ReleaseInterfaces } from '../src/core/interfaces.js';
import { createServer } from '../src/mcp/index.js';
import { protectFixtureDirectory } from './protected-fixture.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'release-parity-'));
  roots.push(root);
  protectFixtureDirectory(root);
  const configPath = join(root, 'release-gate.yaml');
  const { publicKey } = generateKeyPairSync('ed25519');
  await writeFile(
    configPath,
    JSON.stringify({
      releaseGate: {
        directory: 'ledger',
        approvalDirectory: 'approvals',
        trustedPublicKeys: {
          test: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
        },
        policies: [
          {
            provider: 'synthetic',
            target: 'app',
            operation: 'release',
            id: 'test-policy',
            mode: 'write',
          },
        ],
      },
    }),
    { mode: 0o600 },
  );
  const config = await loadReleaseConfig(configPath);
  const provider = {
    inspect: async () => ({ revision: 'one' }),
    dryRun: async () => ({ validated: true }),
    execute: async () => ({ committed: true }),
    verify: async () => ({ verified: true }),
    reconcile: async () => ({ status: 'unresolved' as const, evidence: {} }),
  };
  const server = createServer(new ReleaseInterfaces(config, () => provider));
  const client = new Client({ name: 'parity-test', version: '1.0.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { root, configPath, client, server };
}

async function cli(args: string[], configPath: string) {
  let output = '';
  const spy = vi.spyOn(stdout, 'write').mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof stdout.write);
  try {
    const code = await runCli([...args, '--config', configPath, '--json']);
    return { code, result: JSON.parse(output) };
  } finally {
    spy.mockRestore();
  }
}
async function mcp(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text: string }>;
  if (content[0]?.type !== 'text') throw new Error('Expected MCP text result');
  return {
    isError: result.isError === true,
    result: JSON.parse(content[0].text),
  };
}

describe('CLI and MCP parity', () => {
  it('shares persisted plans and status across both transports', async () => {
    const { root, configPath, client, server } = await setup();
    try {
      const plan = {
        provider: 'synthetic',
        target: 'app',
        operation: 'release',
        policy: { id: 'test-policy', mode: 'write' },
      };
      const planPath = join(root, 'plan.json');
      await writeFile(planPath, JSON.stringify(plan));
      const created = await cli(['plan', planPath], configPath);
      expect(created.code).toBe(0);
      const hash = created.result.evidence[0].planHash;
      const planned = await mcp(client, 'release_status');
      expect(planned.result.evidence[0].pendingPlans).toEqual([
        { planHash: hash, target: 'app', status: 'planned', expiresAt: null },
      ]);
      const approvalCli = await cli(['approval-status', hash], configPath);
      const approvalMcp = await mcp(client, 'release_approval_status', {
        planHash: hash,
      });
      expect(approvalCli.result.status).toBe(approvalMcp.result.status);
      expect(approvalCli.result.evidence).toEqual(approvalMcp.result.evidence);
      const cliStatus = await cli(['status'], configPath);
      const mcpStatus = await mcp(client, 'release_status');
      expect(cliStatus.result.evidence).toEqual(mcpStatus.result.evidence);
      const dry = await mcp(client, 'release_dry_run', { planHash: hash });
      expect(dry.isError).toBe(false);
      expect(dry.result.status).toBe('pass');
      const pending = await mcp(client, 'release_status');
      expect(pending.result.evidence[0].pendingPlans).toEqual([
        {
          planHash: hash,
          target: 'app',
          status: 'awaiting-approval',
          expiresAt: null,
        },
      ]);
      const listing = await cli(['ledger', 'list'], configPath);
      expect(
        listing.result.evidence[0].some(
          (entry: { type: string }) => entry.type === 'dry-run',
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  }, 120_000);
  it('reports the same blocked result for an invalid hash and never exposes approval', async () => {
    const { configPath, client, server } = await setup();
    try {
      const cliResult = await cli(['verify', 'invalid'], configPath);
      const mcpResult = await mcp(client, 'release_verify', {
        planHash: 'invalid',
      });
      expect(cliResult.code).toBe(2);
      expect(cliResult.result.status).toBe('blocked');
      expect(mcpResult.isError).toBe(true);
      expect(mcpResult.result.summary).toBe(cliResult.result.summary);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === 'release_approve')).toBe(
        false,
      );
    } finally {
      await client.close();
      await server.close();
    }
  }, 60_000);
});
