import { describe, expect, it } from 'vitest';
import {
  type PlayConfig,
  type PlayOperation,
  playDryRun,
  playExecute,
  playVerify,
  queryVitals,
  readReviews,
  validatePlayOperation,
} from '../src/core/providers/play.js';

const operation: PlayOperation = {
  track: 'internal',
  release: {
    name: 'Synthetic release',
    versionCodes: ['42'],
    status: 'completed',
    releaseNotes: [{ language: 'en-US', text: 'Synthetic changes' }],
  },
};
function fixture(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Array<{ url: string; method: string; body: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    const next = responses.shift();
    if (!next) throw new Error('Unexpected request');
    return new Response(
      next.body === undefined ? null : JSON.stringify(next.body),
      { status: next.status ?? 200 },
    );
  };
  const config: PlayConfig = {
    packageName: 'com.example.synthetic',
    accessToken: 'synthetic-token',
    fetch: fetcher,
  };
  return { config, calls };
}
const edit = { body: { id: 'edit-1' } };
const track = { body: { track: 'internal', releases: [operation.release] } };

describe('Play publisher synthetic HTTP fixtures', () => {
  it('stages and validates a dry run, then deletes without committing', async () => {
    const { config, calls } = fixture([edit, track, edit, { status: 204 }]);
    expect((await playDryRun(config, operation)).committed).toBe(false);
    expect(calls.map((c) => c.method)).toEqual([
      'POST',
      'PUT',
      'POST',
      'DELETE',
    ]);
    expect(calls[2]?.url).toContain('edit-1:validate');
    expect(calls.some((c) => c.url.includes(':commit'))).toBe(false);
    expect(calls[1]).toBeDefined();
    expect(JSON.parse(calls[1]?.body ?? '')).toEqual(track.body);
  });
  it('validates before committing and does not delete the committed edit', async () => {
    const { config, calls } = fixture([edit, track, edit, edit]);
    expect((await playExecute(config, operation)).committed).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PUT', 'POST', 'POST']);
    expect(calls[3]?.url).toContain('edit-1:commit');
  });
  it('deletes the edit when validation fails', async () => {
    const { config, calls } = fixture([
      edit,
      track,
      { status: 400 },
      { status: 204 },
    ]);
    await expect(playExecute(config, operation)).rejects.toThrow('(400)');
    expect(calls.at(-1)?.method).toBe('DELETE');
    expect(calls.some((c) => c.url.includes(':commit'))).toBe(false);
  });
  it('leaves an uncertain commit for reconciliation', async () => {
    const { config, calls } = fixture([edit, track, edit, { status: 503 }]);
    await expect(playExecute(config, operation)).rejects.toThrow('(503)');
    expect(calls.at(-1)?.url).toContain(':commit');
  });
  it('verifies version, name, status and notes from a fresh track read', async () => {
    const { config } = fixture([
      edit,
      { body: { tracks: [track.body] } },
      { status: 204 },
    ]);
    expect(await playVerify(config, operation)).toBe(true);
  });
  it('rejects overlong or duplicate localized notes', () => {
    expect(() =>
      validatePlayOperation({
        ...operation,
        release: {
          ...operation.release,
          releaseNotes: [{ language: 'en-US', text: '😀'.repeat(501) }],
        },
      }),
    ).toThrow('500');
    expect(() =>
      validatePlayOperation({
        ...operation,
        release: {
          ...operation.release,
          releaseNotes: [
            { language: 'en-US', text: 'one' },
            { language: 'en-us', text: 'two' },
          ],
        },
      }),
    ).toThrow('duplicate');
  });
  it('addresses reviews and reporting on their respective APIs', async () => {
    const { config, calls } = fixture([
      { body: { reviews: [] } },
      { body: { rows: [] } },
    ]);
    await readReviews(config, { maxResults: 20 });
    await queryVitals(config, 'crashRate', { metrics: ['crashRate'] });
    expect(calls[0]?.url).toContain('/reviews?maxResults=20');
    expect(calls[1]?.url).toContain(
      'playdeveloperreporting.googleapis.com/v1beta1/apps/com.example.synthetic/crashRateMetricSet:query',
    );
  });
});
