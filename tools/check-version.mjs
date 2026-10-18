import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../src/version.mjs';

export function checkTag(version, tag) {
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) throw new Error(`Invalid product version: ${version}`);
  if (tag && tag !== `v${version}`) throw new Error(`Release tag ${tag} does not match package version v${version}`);
}

export function checkVersion({ launcher = false, tag } = {}) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  checkTag(version, tag);
  if (VERSION !== version) throw new Error('Engine version differs from package.json');
  if (launcher) {
    const result = spawnSync('dotnet', ['msbuild', 'launcher/CodeAtlas.Launcher.csproj', '-getProperty:Version'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    if (result.status !== 0 || result.stdout.trim() !== version) throw new Error(`Launcher version mismatch: ${result.stdout || result.stderr || result.error}`);
  }
  return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const index = process.argv.indexOf('--tag');
    const tag = index >= 0 ? process.argv[index + 1] : process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
    if (index >= 0 && !tag) throw new Error('--tag requires a release tag');
    console.log(`Version checks passed: ${checkVersion({ launcher: process.argv.includes('--launcher'), tag })}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
