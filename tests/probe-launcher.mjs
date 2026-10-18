import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateBundle } from '../shared/bundle-contract.mjs';

if (process.platform !== 'win32') throw new Error('Launcher runtime checks require Windows.');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'build', 'launcher-probe-'));
const extraction = path.join(root, 'build', 'launcher-extract');
fs.mkdirSync(extraction, { recursive: true });
const target = path.join(work, '中文 project');
fs.mkdirSync(target);
fs.writeFileSync(path.join(target, 'entry.js'), 'export class LauncherProbe { run() { return 42; } }\n');

function run(label, args, expected = 0) {
  const log = path.join(work, `${label}.log`);
  const result = spawnSync(path.join(root, 'CodeAtlas.exe'), ['--headless', '--log', log, ...args], {
    cwd: root, windowsHide: true, encoding: 'utf8', timeout: 45000,
    // Single-file .NET extraction must use a writable directory even in restricted runners.
    // Do not change the user's environment or the launcher's production extraction defaults.
    env: { ...process.env, DOTNET_DISABLE_GUI_ERRORS: '1', DOTNET_BUNDLE_EXTRACT_BASE_DIR: extraction },
  });
  const output = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${label}: ${result.stderr}\n${output}`);
  assert.ok(output.length > 0, `${label}: missing headless log`);
  console.log(`[launcher] ${label}: exit ${result.status}`);
  return output;
}

const langs = run('languages', ['--list-langs']);
assert.match(langs, /node = .*\[ok=True\]/);
assert.match(langs, /javascript/);
assert.match(langs, /python/);
const draft = path.join(work, 'draft.json');
run('draft', ['--draft-facets', target, '--draft-out', draft, '--lang', 'javascript']);
assert.ok(Array.isArray(JSON.parse(fs.readFileSync(draft, 'utf8')).systems));
const out = path.join(work, '扫描 output');
run('scan', ['--path', target, '--out', out, '--lang', 'javascript']);
const bundle = JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8'));
validateBundle(bundle);
assert.equal(bundle.files.length, 1);
assert.ok(bundle.types.some((type) => type.name === 'LauncherProbe'));
assert.match(run('invalid-port', ['--port', 'abc'], 1), /ERROR:/);
assert.match(run('missing-value', ['--path'], 1), /ERROR:/);
run('missing-target', ['--path', path.join(work, 'nonexistent'), '--out', path.join(work, 'failed-output'), '--lang', 'javascript'], 1);
assert.ok(!fs.existsSync(path.join(work, 'failed-output', 'bundle.json')));
console.log(`Launcher headless checks passed (6 cases). Logs: ${work}`);
