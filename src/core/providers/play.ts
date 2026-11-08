import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export interface PlayConfig {
  packageName: string;
  accessToken: string;
  fetch?: typeof fetch;
}
export interface PlayNote {
  language: string;
  text: string;
}
export interface PlayRelease {
  name: string;
  versionCodes: string[];
  releaseNotes?: PlayNote[];
  status: 'draft' | 'inProgress' | 'halted' | 'completed';
  userFraction?: number;
}
export interface PlayTrack {
  track: string;
  releases?: PlayRelease[];
}
export interface PlayOperation {
  track: string;
  release: PlayRelease;
  bundlePath?: string;
}

const publisher = 'https://androidpublisher.googleapis.com';
const reporting = 'https://playdeveloperreporting.googleapis.com/v1beta1';
const enc = encodeURIComponent;

async function request<T>(
  config: PlayConfig,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${config.accessToken}`);
  const response = await (config.fetch ?? fetch)(url, { ...init, headers });
  if (!response.ok)
    throw new Error(
      `Google Play API ${init.method ?? 'GET'} failed (${response.status})`,
    );
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
function base(config: PlayConfig): string {
  if (!config.packageName || !config.accessToken)
    throw new Error('Play packageName and accessToken are required');
  return `${publisher}/androidpublisher/v3/applications/${enc(config.packageName)}`;
}
function json(method: string, value: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}
export function validatePlayOperation(operation: PlayOperation): void {
  if (!operation.track || !operation.release.name)
    throw new Error('Play track and release name are required');
  if (
    !operation.release.versionCodes.length ||
    operation.release.versionCodes.some((code) => !/^[1-9]\d*$/.test(code))
  )
    throw new Error('Play version codes must be positive integer strings');
  if (
    !['draft', 'inProgress', 'halted', 'completed'].includes(
      operation.release.status,
    )
  )
    throw new Error('Invalid Play release status');
  const fraction = operation.release.userFraction;
  if (
    operation.release.status === 'inProgress' ||
    operation.release.status === 'halted'
      ? !(typeof fraction === 'number' && fraction > 0 && fraction < 1)
      : fraction !== undefined
  )
    throw new Error(
      'Play rollout fraction must be between 0 and 1 for inProgress or halted releases only',
    );
  const locales = new Set<string>();
  for (const note of operation.release.releaseNotes ?? []) {
    let language: string;
    try {
      language = Intl.getCanonicalLocales(note.language)[0] ?? '';
    } catch {
      throw new Error(`Invalid release note locale: ${note.language}`);
    }
    if (!language || locales.has(language))
      throw new Error(
        `Invalid or duplicate release note locale: ${note.language}`,
      );
    if (Array.from(note.text).length > 500)
      throw new Error(
        `Release notes exceed 500 Unicode characters: ${note.language}`,
      );
    locales.add(language);
  }
}
async function createEdit(config: PlayConfig): Promise<string> {
  const edit = await request<{ id?: string }>(
    config,
    `${base(config)}/edits`,
    json('POST', {}),
  );
  if (!edit.id) throw new Error('Play did not return an edit ID');
  return edit.id;
}
async function deleteEdit(config: PlayConfig, id: string): Promise<void> {
  await request(config, `${base(config)}/edits/${enc(id)}`, {
    method: 'DELETE',
  });
}
async function stage(
  config: PlayConfig,
  id: string,
  operation: PlayOperation,
  bytes: Buffer | null,
): Promise<PlayTrack> {
  if (bytes) {
    const uploaded = await request<{ versionCode?: number | string }>(
      config,
      `${publisher}/upload/androidpublisher/v3/applications/${enc(config.packageName)}/edits/${enc(id)}/bundles?uploadType=media`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes as unknown as BodyInit,
      },
    );
    if (
      uploaded.versionCode === undefined ||
      !operation.release.versionCodes.includes(String(uploaded.versionCode))
    )
      throw new Error(
        'Uploaded bundle version does not match planned version codes',
      );
  }
  return request<PlayTrack>(
    config,
    `${base(config)}/edits/${enc(id)}/tracks/${enc(operation.track)}`,
    json('PUT', { track: operation.track, releases: [operation.release] }),
  );
}
async function runEdit(
  config: PlayConfig,
  operation: PlayOperation,
  commit: boolean,
  expectedDigest?: string | null,
): Promise<{
  editId: string;
  track: PlayTrack;
  committed: boolean;
  bundleSha256: string | null;
}> {
  validatePlayOperation(operation);
  const bytes = operation.bundlePath
    ? await readFile(operation.bundlePath)
    : null;
  const bundleSha256 = bytes
    ? createHash('sha256').update(bytes).digest('hex')
    : null;
  if (expectedDigest !== undefined && bundleSha256 !== expectedDigest)
    throw new Error('Play bundle changed since approval');
  const editId = await createEdit(config);
  let committed = false;
  let commitAttempted = false;
  try {
    const track = await stage(config, editId, operation, bytes);
    await request(config, `${base(config)}/edits/${enc(editId)}:validate`, {
      method: 'POST',
    });
    if (commit) {
      commitAttempted = true;
      await request(config, `${base(config)}/edits/${enc(editId)}:commit`, {
        method: 'POST',
      });
      committed = true;
    }
    return { editId, track, committed, bundleSha256 };
  } finally {
    // A failed commit may have succeeded remotely; never mutate its edit during reconciliation.
    if (!commitAttempted) await deleteEdit(config, editId);
  }
}
export async function playDryRun(config: PlayConfig, operation: PlayOperation) {
  const { track, committed, bundleSha256 } = await runEdit(
    config,
    operation,
    false,
  );
  return { track, committed, bundleSha256 };
}
export async function playBundleDigest(
  operation: PlayOperation,
): Promise<string | null> {
  return operation.bundlePath
    ? createHash('sha256')
        .update(await readFile(operation.bundlePath))
        .digest('hex')
    : null;
}
export async function playExecute(
  config: PlayConfig,
  operation: PlayOperation,
  expectedDigest?: string | null,
) {
  return runEdit(config, operation, true, expectedDigest);
}
export async function readTracks(config: PlayConfig): Promise<PlayTrack[]> {
  const editId = await createEdit(config);
  try {
    const result = await request<{ tracks?: PlayTrack[] }>(
      config,
      `${base(config)}/edits/${enc(editId)}/tracks`,
    );
    return result.tracks ?? [];
  } finally {
    await deleteEdit(config, editId);
  }
}
export async function playInspect(config: PlayConfig) {
  return { tracks: await readTracks(config) };
}
export async function playVerify(
  config: PlayConfig,
  operation: PlayOperation,
): Promise<boolean> {
  validatePlayOperation(operation);
  const track = (await readTracks(config)).find(
    (item) => item.track === operation.track,
  );
  return !!track?.releases?.some(
    (release) =>
      release.name === operation.release.name &&
      release.status === operation.release.status &&
      release.userFraction === operation.release.userFraction &&
      operation.release.versionCodes.every((code) =>
        release.versionCodes.includes(code),
      ) &&
      (operation.release.releaseNotes ?? []).every((note) =>
        release.releaseNotes?.some(
          (actual) =>
            actual.language.toLowerCase() === note.language.toLowerCase() &&
            actual.text === note.text,
        ),
      ),
  );
}
export async function playReconcile(
  config: PlayConfig,
  operation: PlayOperation,
): Promise<'observed' | 'unknown'> {
  return (await playVerify(config, operation)) ? 'observed' : 'unknown';
}
export async function readReviews(
  config: PlayConfig,
  options: {
    token?: string;
    maxResults?: number;
    translationLanguage?: string;
  } = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  if (options.token) query.set('token', options.token);
  if (options.maxResults !== undefined)
    query.set('maxResults', String(options.maxResults));
  if (options.translationLanguage)
    query.set('translationLanguage', options.translationLanguage);
  return request(
    config,
    `${base(config)}/reviews${query.size ? `?${query}` : ''}`,
  );
}
export async function queryVitals(
  config: PlayConfig,
  metric: 'crashRate' | 'anrRate',
  query: Record<string, unknown>,
): Promise<unknown> {
  base(config);
  return request(
    config,
    `${reporting}/apps/${enc(config.packageName)}/${metric}MetricSet:query`,
    json('POST', query),
  );
}
