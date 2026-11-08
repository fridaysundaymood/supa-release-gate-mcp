import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { isEntrypoint } from './is-entrypoint.js';

it.skipIf(process.platform === 'win32')(
  'recognizes a symlinked executable without treating imports as entrypoints',
  () => {
    const root = mkdtempSync(join(tmpdir(), 'release-entrypoint-'));
    const original = process.argv[1];
    try {
      const target = join(root, 'entry.js');
      const link = join(root, 'bin');
      writeFileSync(target, '');
      symlinkSync(target, link, 'file');
      process.argv[1] = link;
      expect(isEntrypoint(pathToFileURL(target).href)).toBe(true);
      expect(isEntrypoint(import.meta.url)).toBe(false);
    } finally {
      process.argv[1] = original;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
