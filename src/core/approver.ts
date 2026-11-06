import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  scryptSync,
  sign,
} from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { type Approval, canonicalJson, type Resolution } from './gate.js';

export type ApprovalPayload = Omit<Approval, 'signature' | 'keyId'>;
export type ResolutionPayload = Omit<Resolution, 'signature' | 'keyId'>;
interface KeyFile {
  version: 1;
  keyId: string;
  publicKey: string;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/**
 * The directory and passphrase must be inaccessible to the agent, and the public
 * key must be pinned independently in protected gate configuration. A TTY or an
 * encrypted key alone does not establish a human-only trust boundary.
 */
export async function initApprover(
  directory: string,
  passphrase: string,
): Promise<{ keyId: string; publicKey: string }> {
  if (!directory || !passphrase)
    throw new Error('A private directory and nonempty passphrase are required');
  const keys = generateKeyPairSync('ed25519');
  const publicKey = keys.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  const keyId = createHash('sha256')
    .update(keys.publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
  const privateKey = keys.privateKey.export({ format: 'der', type: 'pkcs8' });
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(keyId));
    const ciphertext = Buffer.concat([
      cipher.update(privateKey),
      cipher.final(),
    ]);
    const file: KeyFile = {
      version: 1,
      keyId,
      publicKey,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(join(directory, 'approver.json'), 'wx', 0o600);
    try {
      await handle.writeFile(`${canonicalJson(file)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { keyId, publicKey };
  } finally {
    key.fill(0);
    privateKey.fill(0);
  }
}

async function signPayload<T extends ApprovalPayload | ResolutionPayload>(
  directory: string,
  passphrase: string,
  payload: T,
): Promise<T & { keyId: string; signature: string }> {
  if (!passphrase) throw new Error('Passphrase required');
  const file = JSON.parse(
    await readFile(join(directory, 'approver.json'), 'utf8'),
  ) as KeyFile;
  if (
    file.version !== 1 ||
    typeof file.keyId !== 'string' ||
    typeof file.publicKey !== 'string' ||
    typeof file.salt !== 'string' ||
    typeof file.iv !== 'string' ||
    typeof file.tag !== 'string' ||
    typeof file.ciphertext !== 'string'
  )
    throw new Error('Invalid approval key file');
  const publicKey = createPublicKey(file.publicKey);
  const keyId = createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' }))
    .digest('hex');
  if (publicKey.asymmetricKeyType !== 'ed25519' || keyId !== file.keyId)
    throw new Error('Invalid approval public key');
  const salt = Buffer.from(file.salt, 'base64');
  const iv = Buffer.from(file.iv, 'base64');
  const tag = Buffer.from(file.tag, 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16)
    throw new Error('Invalid encrypted key parameters');
  const key = scryptSync(passphrase, salt, 32, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  let decrypted: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(keyId));
    decipher.setAuthTag(tag);
    decrypted = Buffer.concat([
      decipher.update(Buffer.from(file.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const privateKey = createPrivateKey({
      key: decrypted,
      format: 'der',
      type: 'pkcs8',
    });
    if (
      privateKey.asymmetricKeyType !== 'ed25519' ||
      !createPublicKey(privateKey)
        .export({ format: 'der', type: 'spki' })
        .equals(publicKey.export({ format: 'der', type: 'spki' }))
    )
      throw new Error('Approval key mismatch');
    const signed = { ...payload, keyId };
    return {
      ...signed,
      signature: sign(
        null,
        Buffer.from(canonicalJson(signed)),
        privateKey,
      ).toString('base64'),
    };
  } finally {
    key.fill(0);
    decrypted?.fill(0);
  }
}

/** Sign a reviewed payload; the caller must enforce the human boundary. */
export async function signApproval(
  directory: string,
  passphrase: string,
  payload: ApprovalPayload,
): Promise<Approval> {
  return signPayload(directory, passphrase, payload);
}

export async function signResolution(
  directory: string,
  passphrase: string,
  payload: ResolutionPayload,
): Promise<Resolution> {
  return signPayload(directory, passphrase, payload);
}

export function promptPassphrase(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY || process.env.CI)
    throw new Error(
      'Approval requires a human-controlled interactive terminal outside CI',
    );
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  let value = '';
  stderr.write('Approval key passphrase: ');
  stdin.setRawMode(true);
  stdin.resume();
  const finish = (error?: Error) => {
    stdin.off('data', onData);
    stdin.setRawMode(false);
    stdin.pause();
    stderr.write('\n');
    if (error) reject(error);
    else resolve(value);
  };
  const onData = (chunk: Buffer) => {
    for (const char of chunk.toString('utf8')) {
      if (char === '\u0003' || char === '\u0004') {
        finish(new Error('Approval cancelled'));
        return;
      }
      if (char === '\r' || char === '\n') {
        finish();
        return;
      }
      if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
      else if (char >= ' ') value += char;
    }
  };
  stdin.on('data', onData);
  return promise;
}

/** Interactive convenience only; callers must display the complete plan and evidence first. */
export async function promptApproval(
  directory: string,
  payload: ApprovalPayload,
): Promise<Approval> {
  if (!stdin.isTTY || !stdout.isTTY || process.env.CI)
    throw new Error(
      'Approval requires a human-controlled interactive terminal outside CI',
    );
  const rl = createInterface({ input: stdin, output: stderr });
  let confirmation: string;
  try {
    confirmation = await rl.question(
      `Type the exact target to approve (${payload.target}): `,
    );
  } finally {
    rl.close();
  }
  if (confirmation !== payload.target)
    throw new Error('Target confirmation did not match');
  return signApproval(directory, await promptPassphrase(), payload);
}

/** The caller must display the intent and complete resolution evidence first. */
export async function promptResolution(
  directory: string,
  payload: ResolutionPayload,
): Promise<Resolution> {
  if (!stdin.isTTY || !stdout.isTTY || process.env.CI)
    throw new Error(
      'Resolution requires a human-controlled interactive terminal outside CI',
    );
  const rl = createInterface({ input: stdin, output: stderr });
  let confirmation: string;
  try {
    confirmation = await rl.question(
      `Type the exact target to resolve (${payload.target}): `,
    );
  } finally {
    rl.close();
  }
  if (confirmation !== payload.target)
    throw new Error('Target confirmation did not match');
  return signResolution(directory, await promptPassphrase(), payload);
}
