import { describe, expect, it } from 'vitest';
import { tools } from './index.js';

describe('release tool parity', () => {
  it('exposes every agent operation exactly once and never exposes approval', () => {
    expect(Object.values(tools).sort()).toEqual(
      [
        'approval-status',
        'doctor',
        'dry-run',
        'execute',
        'ledger-list',
        'ledger-render',
        'plan',
        'recover',
        'status',
        'verify',
      ].sort(),
    );
    expect(Object.keys(tools)).not.toContain('release_approve');
  });
});
