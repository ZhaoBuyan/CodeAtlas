import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { RUNTIME_FILES } from '../tools/payload-files.mjs';

test('packaged runtime contains every relative static JavaScript dependency', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = new Set(RUNTIME_FILES);
  for (const file of files) {
    if (!/\.(mjs|js)$/.test(file)) continue;
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/^import\s+(?:[^;\n]*?\sfrom\s*)?['"](\.[^'"]+)['"]/gm)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      assert.ok(files.has(dependency), `${file} requires missing payload file ${dependency}`);
    }
  }
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'atlas-runtime-surface-'));
  for (const file of [...files, 'package.json']) {
    const target = path.join(stage, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(root, file), target);
  }
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "const m = await import('./src/mcp.mjs'); if (!m.listToolsText().includes('unresolved')) process.exit(1);"], { cwd: stage, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
