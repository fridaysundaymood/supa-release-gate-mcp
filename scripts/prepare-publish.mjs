import {
  appendFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = process.env.GITHUB_REF_NAME;
if (tag && tag !== `v${pkg.version}`) {
  throw new Error(`Tag ${tag} does not match version ${pkg.version}`);
}
for (const section of [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]) {
  for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
    if (!name.startsWith('@budaknyenyel/') || !spec.startsWith('file:'))
      continue;
    const dependency = JSON.parse(
      readFileSync(resolve(root, spec.slice(5), 'package.json'), 'utf8'),
    );
    if (dependency.name !== name)
      throw new Error(`Dependency name mismatch: ${name}`);
    pkg[section][name] = `^${dependency.version}`;
  }
}
const staging = mkdtempSync(join(tmpdir(), 'release-publish-'));
symlinkSync(
  join(root, 'node_modules'),
  join(staging, 'node_modules'),
  'junction',
);
for (const name of [
  'dist',
  'src',
  'skills',
  'AGENTS.md',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'tsconfig.json',
  'tsconfig.base.json',
]) {
  cpSync(join(root, name), join(staging, name), { recursive: true });
}
writeFileSync(
  join(staging, 'package.json'),
  `${JSON.stringify(pkg, null, 2)}\n`,
);
if (process.env.GITHUB_OUTPUT)
  appendFileSync(process.env.GITHUB_OUTPUT, `directory=${staging}\n`);
console.log(staging);
