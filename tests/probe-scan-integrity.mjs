/** Generated inputs only: root identity, cache isolation, watch discovery, MCP recovery. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { importMatchesTarget } from '../src/modules.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(repo, 'tests/.out'), { recursive: true });
const work = fs.mkdtempSync(path.join(repo, 'tests/.out/integrity-'));
const cli = path.join(repo, 'src/cli.mjs');
const node = process.env.NODE_BIN || process.execPath;
const env = { ...process.env, CODEATLAS_LANG: 'en' };
const write = (rel, text) => {
  const file = path.join(work, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const scan = (roots, out, incremental = false, extra = []) => {
  const result = spawnSync(node, [cli, 'scan', ...roots.map((r) => path.join(work, r)), '--out', path.join(work, out), '--lang', 'javascript', ...(incremental ? ['--incremental'] : []), ...extra],
    { cwd: repo, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const bundle = JSON.parse(fs.readFileSync(path.join(work, out, 'bundle.json'), 'utf8'));
  assert.deepEqual(bundle.diagnostics?.failedLanguages || [], []);
  return { bundle, log: result.stdout };
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 30000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (predicate()) return;
    await delay(100);
  }
  assert.fail(`Timed out: ${label}`);
}
function connectMcp(out) {
  const child = spawn(node, [cli, 'mcp', '--out', path.join(work, out)], { cwd: repo, env, windowsHide: true });
  const replies = [];
  let buffer = '', errors = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  child.stderr.on('data', (chunk) => { errors += chunk; });
  let id = 0;
  return {
    child, replies,
    async call(method, params) {
      const requestId = ++id;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      await waitFor(() => replies.some((r) => r.id === requestId) || child.exitCode !== null, `MCP ${method}: ${errors}`);
      assert.equal(child.exitCode, null, errors);
      return replies.find((r) => r.id === requestId);
    },
  };
}

// Keep metadata identical so a relative-path-only cache would return the wrong class.
for (const [root, name] of [['a', 'Alpha'], ['b', 'Bravo']]) {
  const file = write(`${root}/same.js`, `export class ${name} {}\n`);
  fs.utimesSync(file, new Date('2026-01-01'), new Date('2026-01-01'));
}
scan(['a'], 'cache');
const switched = scan(['b'], 'cache', true);
assert.deepEqual(switched.bundle.types.map((t) => t.name), ['Bravo']);
assert.match(switched.log, /reused 0 unchanged files/);
assert.match(scan(['b'], 'cache', true).log, /re-parsing 0/);
assert.equal(switched.bundle.files[0].path, 'same.js', 'single-root paths stay compatible');
write('b/package.json', '{"name":"changed-project-input"}\n');
assert.match(scan(['b'], 'cache', true).log, /reused 0 unchanged files/, 'project inputs invalidate cached extraction');
console.log('✓ cache is scoped to roots; unchanged files are still reused');

{
  for (const name of ['keep.js', 'extra/skip.js', 'private=copy.js', 'one.generated.js', 'project.js', 'git.js']) write(`scope/${name}`, 'export class ScopeItem {}\n');
  write('scope/atlas.ignore', 'project.js\n'); write('scope/.gitignore', 'git.js\n');
  const plain = scan(['scope'], 'scope-default').bundle;
  const empty = scan(['scope'], 'scope-empty', false, ['--ignore-patterns=   ']).bundle;
  for (const key of ['files', 'types', 'edges', 'totals']) assert.deepEqual(empty[key], plain[key]);
  const rules = 'extra/\r\nprivate=copy.js\r\n*.generated.js';
  const custom = scan(['scope'], 'scope-custom', false, [`--ignore-patterns=${rules}`]).bundle;
  assert.deepEqual(custom.files.map((f) => f.path), ['keep.js']);
  assert.ok(custom.stats.skipped.projectBySrc['--ignore-patterns'] >= 2);
  const override = scan(['scope'], 'scope-custom', true, ['--ignore-patterns=private=copy.js']);
  assert.match(override.log, /reused 0 unchanged files/, 'changing explicit rules invalidates cached extraction');
  assert.equal(override.bundle.files.length, 3);
  const noGit = scan(['scope'], 'scope-no-git', false, [`--ignore-patterns=${rules}`, '--no-gitignore']).bundle;
  assert.deepEqual(noGit.files.map((f) => f.path).sort(), ['git.js', 'keep.js']);
  const out = path.join(work, 'scope-auto');
  const auto = spawn(node, [cli, path.join(work, 'scope'), '--out', out, '--lang', 'javascript', `--ignore-patterns=${rules}`, '--no-open', '--port', '0'], { cwd: repo, env, windowsHide: true });
  let autoLog = '';
  auto.stdout.on('data', (b) => { autoLog += b; }); auto.stderr.on('data', (b) => { autoLog += b; });
  try {
    await waitFor(() => fs.existsSync(path.join(out, 'bundle.json')) || auto.exitCode !== null, 'auto entry exclusions');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'))).files.map((f) => f.path), ['keep.js'], autoLog);
  } finally { auto.kill(); }
  const ingested = path.join(work, 'scope-ingest');
  const ingest = spawnSync(node, [cli, 'ingest', path.join(work, 'scope'), '--out', ingested, '--lang', 'javascript', `--ignore-patterns=${rules}`, '--no-gitignore'], { cwd: repo, env, windowsHide: true, encoding: 'utf8', timeout: 60000 });
  assert.equal(ingest.status, 0, ingest.stdout + ingest.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(ingested, 'bundle.json'))).files.map((f) => f.path).sort(), ['git.js', 'keep.js']);
  console.log('✓ explicit rules compose with project rules across scan/auto entries, preserve blank defaults and invalidate caches');
}

{
  const file = write('hash/main.js', 'export class Alpha {}\n');
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, stamp, stamp);
  const plain = scan(['hash'], 'hash-off').bundle;
  const cold = scan(['hash'], 'hash-on', false, ['--cache-hash']).bundle;
  for (const key of ['files', 'types', 'edges', 'totals', 'unresolved']) assert.deepEqual(cold[key], plain[key]);
  assert.equal(JSON.stringify(cold).includes('contentHash'), false, 'hash is cache-only');
  const touched = new Date('2026-01-02T00:00:00Z');
  fs.utimesSync(file, touched, touched);
  const reused = scan(['hash'], 'hash-on', true, ['--cache-hash']);
  assert.match(reused.log, /reused 1 unchanged files/);
  assert.equal(reused.bundle.files[0].mtime, touched.getTime(), 'reused facts get current metadata');
  fs.writeFileSync(file, 'export class Bravo {}\n');
  fs.utimesSync(file, touched, touched);
  const changed = scan(['hash'], 'hash-on', true, ['--cache-hash']);
  assert.match(changed.log, /reused 0 unchanged files/);
  assert.deepEqual(changed.bundle.types.map((t) => t.name), ['Bravo']);
  const fresh = scan(['hash'], 'hash-cold').bundle;
  for (const key of ['files', 'types', 'edges', 'totals', 'unresolved']) assert.deepEqual(changed.bundle[key], fresh[key]);
  const missing = scan(['hash'], 'hash-cold', true, ['--cache-hash']);
  assert.match(missing.log, /reused 0 unchanged files/, 'no hash means reparse, never trust metadata');
  console.log('✓ optional content hashes detect same-size/same-mtime edits, reuse touches, refresh metadata and match cold graphs');
}

// Rejected C# targets must be visible in the existing diagnostic sidecar.
{
  const out = path.join(work, 'csharp-diagnostics');
  const sidecar = path.join(out, 'unresolved.tsv');
  const run = (debug, incremental = false) => {
    const result = spawnSync(node, [cli, 'scan', path.join(repo, 'tests/fixtures/csharp-reference-roles'), '--out', out, '--lang', 'csharp', ...(incremental ? ['--incremental'] : [])],
      { cwd: repo, env: { ...env, CA_DEBUG_UNRESOLVED: debug ? sidecar : '' }, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8'));
  };
  const plain = run(false);
  assert.equal(fs.existsSync(sidecar), false, 'diagnostics remain opt-in');
  for (const incremental of [false, true]) {
    const diagnosed = run(true, incremental);
    for (const key of ['files', 'types', 'edges', 'totals', 'unresolved']) assert.deepEqual(diagnosed[key], plain[key], `diagnostics changed ${key}`);
    assert.deepEqual(diagnosed.stats.unresolved, plain.stats.unresolved);
    const rows = fs.readFileSync(sidecar, 'utf8').trim().split(/\r?\n/).map((line) => line.split('\t'));
    for (const [reason, name] of [['csharp-member-global', 'RoleUser'], ['csharp-private-container', 'BitOperations'], ['csharp-generic-arity', 'JsonConverter']]) {
      const row = rows.find((r) => r[0] === name && r[1] === reason);
      assert.ok(row, `missing ${reason} diagnostic`);
      assert.equal(row[2], '1');
      assert.equal(row[3], 'csharp');
      assert.equal(row[4], 'Owners.cs');
      const target = JSON.parse(row[5]);
      assert.equal(target.file, 'Targets.cs');
      assert.equal(target.fqn, name);
      assert.ok(target.line > 0);
    }
    assert.equal(rows.length, diagnosed.unresolved.unknown + diagnosed.unresolved.ambiguous);
    const report = spawnSync(node, [path.join(repo, 'tools/unresolved-report.mjs'), out, '--json'], { cwd: repo, env, encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(report.status, 0, report.stderr);
    const summary = JSON.parse(report.stdout);
    assert.equal(summary.total, rows.length);
    for (const reason of ['csharp-member-global', 'csharp-private-container', 'csharp-generic-arity']) assert.ok(summary.byLangWhy[`csharp / ${reason}`]?.n > 0);
  }
  console.log('✓ C# rejected targets are diagnosed with reasons and source/target identity; cold/warm graphs stay identical');
}

const multi = scan(['a', 'b'], 'multi').bundle;
assert.deepEqual(multi.types.map((t) => t.name).sort(), ['Alpha', 'Bravo']);
assert.equal(new Set(multi.files.map((f) => f.path)).size, 2);
for (const file of multi.files) {
  assert.equal(file.relativePath, 'same.js');
  assert.ok(multi.source.rootPaths[file.rootId]);
}
const reversed = scan(['b', 'a'], 'multi', true);
assert.match(reversed.log, /re-parsing 0/);
assert.deepEqual(reversed.bundle.files, multi.files);
assert.deepEqual(reversed.bundle.types, multi.types);
assert.equal(scan(['a', 'a'], 'deduplicated').bundle.files.length, 1);
console.log('✓ multi-root files stay distinct and stable when roots are reordered');

for (const [root, user] of [['left', 'LeftUser'], ['right', 'RightUser']]) {
  write(`${root}/model.js`, 'export class Widget {}\n');
  write(`${root}/use.js`, `import { Widget } from './model.js';\nexport class ${user} extends Widget {}\n`);
}
const linked = scan(['left', 'right'], 'linked').bundle;
for (const user of linked.types.filter((t) => /User$/.test(t.name))) {
  const edges = linked.edges.filter((e) => e.from === user.id);
  assert.ok(edges.length, `${user.name} has a resolved dependency`);
  for (const edge of edges) {
    const target = linked.types.find((t) => t.id === edge.to);
    assert.equal(linked.files[target.file].rootId, linked.files[user.file].rootId);
  }
}
console.log('✓ relative imports resolve within their own root');
const importContext = { rootPaths: { left: path.join(work, 'left'), right: path.join(work, 'right') },
  fromRootId: 'left', fromRelativePath: 'use.js', fromPath: 'left/use.js' };
const importTarget = { rootId: 'right', relativePath: 'model.js', path: 'right/model.js' };
assert.equal(importMatchesTarget('./model.js', importTarget, importContext), false);
assert.equal(importMatchesTarget('../right/model.js', importTarget, importContext), true);

const mcp = connectMcp('multi');
try {
  const ambiguous = await mcp.call('tools/call', { name: 'file', arguments: { path: 'same.js' } });
  assert.match(ambiguous.result.content[0].text, /2 files match/);
  const exact = await mcp.call('tools/call', { name: 'file', arguments: { path: multi.files[0].path } });
  assert.match(exact.result.content[0].text, /Scan root:/);
  for (const raw of ['null', '[]', '{', '42', '{"jsonrpc":"1.0","id":1,"method":"ping"}']) {
    const before = mcp.replies.length;
    mcp.child.stdin.write(raw + '\n');
    await waitFor(() => mcp.replies.length > before, 'invalid input error');
    assert.ok(mcp.replies.at(-1).error);
    assert.deepEqual((await mcp.call('ping')).result, {});
  }
  for (const params of [null, { name: 'search', arguments: [] }, { name: 'search', arguments: {} },
    { name: 'search', arguments: { query: 3 } }, { name: 'search', arguments: { query: 'x', scope: 'bad' } },
    { name: 'overview', arguments: { extra: true } }, { name: 'toString' }]) {
    assert.equal((await mcp.call('tools/call', params)).error.code, -32602);
  }
  const before = mcp.replies.length;
  mcp.child.stdin.write('x'.repeat(1024 * 1024 + 1));
  await waitFor(() => mcp.replies.length > before, 'oversized unterminated input error');
  mcp.child.stdin.write('\n');
  assert.deepEqual((await mcp.call('ping')).result, {});
  assert.equal((await mcp.call('tools/call', { name: 'overview', arguments: {} })).result.isError, false);
  console.log('✓ MCP rejects malformed, invalid and oversized requests and remains usable');
} finally { mcp.child.kill(); }

// Start with no source files. Both empty directories and the root must be watched.
fs.mkdirSync(path.join(work, 'watch/empty/deep'), { recursive: true });
write('watch/.gitignore', 'ignored/\n');
write('watch/ignored/hidden.js', 'export class Hidden {}\n');
const watcher = spawn(node, [cli, 'scan', path.join(work, 'watch'), '--out', path.join(work, 'watch-out'), '--lang', 'javascript', '--watch', '--no-open'],
  { cwd: repo, env, windowsHide: true });
let watchLog = '';
watcher.stdout.on('data', (chunk) => { watchLog += chunk; });
watcher.stderr.on('data', (chunk) => { watchLog += chunk; });
const watchedBundle = () => {
  try { return JSON.parse(fs.readFileSync(path.join(work, 'watch-out/bundle.json'), 'utf8')); } catch { return null; }
};
const has = (name) => watchedBundle()?.types.some((t) => t.name === name);
try {
  await waitFor(() => watchLog.includes('Watching '), 'empty watch ready');
  write('watch/first.js', 'export class First {}\n');
  await waitFor(() => has('First'), 'first file in empty project');
  write('watch/empty/deep/added.js', 'export class DeepAdded {}\n');
  await waitFor(() => has('DeepAdded'), 'file in pre-existing empty directory');
  write('watch/new/nested/added.js', 'export class NewAdded {}\n');
  await waitFor(() => has('NewAdded'), 'new nested directory');
  assert.equal(has('Hidden'), false);
  write('watch/.gitignore', '# now visible\n');
  await waitFor(() => has('Hidden'), 'ignore rule edit');
  fs.renameSync(path.join(work, 'watch/new/nested'), path.join(work, 'watch/new/renamed'));
  await waitFor(() => watchedBundle()?.files.some((f) => f.path === 'new/renamed/added.js'), 'same-count directory rename');
  assert.equal(watcher.exitCode, null, watchLog);
  console.log('✓ watch detects first files, empty/new directories, rule edits and renames');
} catch (error) {
  throw new Error(`${error.message}\n${watchLog}`, { cause: error });
} finally { watcher.kill(); }

// Hash mode must discover content-only changes before the incremental scan runs.
{
  const file = write('hash-watch/main.js', 'export class Alpha {}\n');
  write('hash-watch/omit.js', 'export class Omitted {}\n');
  const stamp = new Date('2026-01-01T00:00:00Z');
  fs.utimesSync(file, stamp, stamp);
  const child = spawn(node, [cli, 'scan', path.join(work, 'hash-watch'), '--out', path.join(work, 'hash-watch-out'), '--lang', 'javascript', '--watch', '--cache-hash', '--ignore-patterns=omit.js', '--no-open'], { cwd: repo, env, windowsHide: true });
  let log = '';
  child.stdout.on('data', (b) => { log += b; });
  child.stderr.on('data', (b) => { log += b; });
  const read = () => { try { return JSON.parse(fs.readFileSync(path.join(work, 'hash-watch-out/bundle.json'), 'utf8')); } catch { return null; } };
  try {
    await waitFor(() => log.includes('Watching '), 'hash watch ready');
    fs.writeFileSync(file, 'export class Bravo {}\n');
    fs.utimesSync(file, stamp, stamp);
    await waitFor(() => read()?.types.some((t) => t.name === 'Bravo'), 'hash watch same-metadata change');
    assert.deepEqual(read().files.map((f) => f.path), ['main.js'], 'watch stages preserve explicit rules');
    assert.equal(child.exitCode, null, log);
    console.log('✓ hash watch discovers edits with identical size and mtime');
  } finally { child.kill(); }
}

console.log(`All scan-integrity checks passed. Generated inputs: ${work}`);
