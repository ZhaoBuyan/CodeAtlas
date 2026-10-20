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
// Isolate app-adjacent settings from the user's real launcher.config.json.
const executable = path.join(work, 'CodeAtlas.exe');
fs.copyFileSync(path.join(root, 'CodeAtlas.exe'), executable);

function run(label, args, expected = 0) {
  const log = path.join(work, `${label}.log`);
  const result = spawnSync(executable, ['--headless', '--log', log, ...args], {
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
for (const name of ['cache/skip.js', '中文 folder/skip.js', 'private=copy.js', 'one.generated.js', 'project-only.js']) {
  fs.mkdirSync(path.dirname(path.join(target, name)), { recursive: true });
  fs.writeFileSync(path.join(target, name), 'export class ShouldBeSkipped {}\n');
}
fs.writeFileSync(path.join(target, 'atlas.ignore'), 'project-only.js\n');
const configured = path.join(work, 'configured-output');
fs.writeFileSync(path.join(work, 'launcher.config.json'), JSON.stringify({ ExtraIgnore: 'cache/\n中文 folder/\nprivate=copy.js\n*.generated.js' }));
run('configured-exclusions', ['--path', target, '--out', configured, '--lang', 'javascript']);
const excluded = JSON.parse(fs.readFileSync(path.join(configured, 'bundle.json')));
assert.deepEqual(excluded.files.map((f) => f.path), ['entry.js']);
assert.ok(excluded.stats.skipped.projectBySrc['--ignore-patterns'] >= 2);
fs.writeFileSync(path.join(work, 'launcher.config.json'), '{"ExtraIgnore":"   "}');
const blank = path.join(work, 'blank-output');
run('blank-exclusions', ['--path', target, '--out', blank, '--lang', 'javascript']);
assert.equal(JSON.parse(fs.readFileSync(path.join(blank, 'bundle.json'))).files.length, 5);
const assembly = path.join(root, 'launcher/bin/Release/net9.0-windows/win-x64/CodeAtlas.dll');
const settings = spawnSync('dotnet', ['run', '--project', path.join(root, 'tests/LauncherSettingsProbe.csproj'), '--', assembly, path.join(work, 'settings')], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60000 });
assert.ifError(settings.error);
assert.equal(settings.status, 0, settings.stdout + settings.stderr);
console.log(settings.stdout.trim());
console.log(`Launcher headless checks passed (8 cases + settings/UI probe). Logs: ${work}`);
