import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  initApprover,
  promptApproval,
  signApproval,
} from '../src/core/approver.js';
import { canonicalJson } from '../src/core/gate.js';

it('encrypts keys and signs approvals with the initialized identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'approver-'));
  try {
    await expect(initApprover(directory, 'short')).rejects.toThrow(
      'passphrase',
    );
    await expect(
      initApprover(directory, 'aaaaaaaaaaaaaaaaaaaa'),
    ).rejects.toThrow('passphrase');
    const identity = await initApprover(
      directory,
      'correct long passphrase for testing',
    );
    await expect(
      initApprover(directory, 'another long passphrase for testing'),
    ).rejects.toThrow();
    const payload = {
      kind: 'release-gate-approval-v1' as const,
      gateId: 'gate',
      planHash: 'hash',
      target: 'production',
      evidenceHash: 'evidence',
      policyId: 'policy',
      issuedAt: '2029-12-31T23:59:00.000Z',
      expiresAt: '2030-01-01T00:00:00.000Z',
      nonce: 'nonce',
    };
    await expect(signApproval(directory, 'wrong', payload)).rejects.toThrow();
    const { signature, ...signed } = await signApproval(
      directory,
      'correct long passphrase for testing',
      payload,
    );
    expect(signed.keyId).toBe(identity.keyId);
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(signed)),
        identity.publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(true);
    expect(
      verify(
        null,
        Buffer.from(canonicalJson(signed)),
        generateKeyPairSync('ed25519').publicKey,
        Buffer.from(signature, 'base64'),
      ),
    ).toBe(false);
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI)
      await expect(promptApproval(directory, payload)).rejects.toThrow(
        'interactive terminal',
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
