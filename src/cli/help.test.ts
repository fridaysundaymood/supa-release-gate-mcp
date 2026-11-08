import { expect, it, vi } from 'vitest';
import { loadReleaseConfig } from '../core/config.js';
import { runCli } from './index.js';

vi.mock('../core/config.js', () => ({ loadReleaseConfig: vi.fn() }));

it('shows help without loading configuration', async () => {
  const output = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(() => true);
  try {
    for (const flag of ['--help', '-h']) expect(await runCli([flag])).toBe(0);
    expect(loadReleaseConfig).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      expect.stringContaining('approval-status'),
    );
  } finally {
    output.mockRestore();
  }
});
