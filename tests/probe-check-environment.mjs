import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkEnvironment } from '../tools/check-environment.mjs';

test('checks replace unusable TEMP and stop parent Git discovery, including nested repositories', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = { ...process.env, TEMP: path.join(root, 'package.json'), TMP: path.join(root, 'package.json') };
  const env = checkEnvironment(root, parent);
  assert.equal(parent.TEMP, path.join(root, 'package.json'));
  fs.writeFileSync(path.join(env.TEMP, 'writable'), 'ok');
  const child = fs.mkdtempSync(path.join(env.TEMP, 'fixture-'));
  const git = (...args) => spawnSync('git', ['-C', child, ...args], { env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(git('rev-parse', '--show-toplevel').status, 0);
  assert.equal(git('init', '--quiet').status, 0);
  assert.equal(path.resolve(git('rev-parse', '--show-toplevel').stdout.trim()), child);
  const node = spawnSync(process.execPath, ['-e', "require('node:fs').writeFileSync(require('node:path').join(require('node:os').tmpdir(),'child-writable'),'ok')"], { env, windowsHide: true });
  assert.equal(node.status, 0);
});
