import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateBundle } from '../shared/bundle-contract.mjs';
import { createBundleLoader } from '../web/bundle-loader.js';
import { withOutputLock, writeJsonAtomic, readStableJson } from '../src/storage.mjs';
import { payloadSourceFiles } from '../tools/payload-files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'tests/.out'), { recursive: true });
const work = fs.mkdtempSync(path.join(root, 'tests/.out/bundle-updates-'));
const node = process.env.NODE_BIN || process.execPath;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, label) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(50); }
  assert.fail(`Timed out: ${label}`);
}
function bundle(name = 'Alpha') {
  return {
    schema: 'code-atlas/1', generated: new Date().toISOString(), generator: { name: 'code-atlas', version: '1.9.0' },
    source: { roots: [work], labels: ['generated'], scanMs: 1 },
    totals: { files: 1, types: 1, code: 1, loc: 1, blank: 0, comment: 0, bytes: 20, edges: 0 },
    files: [{ id: 0, path: 'a.js', lang: 'javascript', loc: 1, code: 1, comment: 0, blank: 0, types: [0], imports: [] }],
    types: [{ id: 0, file: 0, name, fqn: name, ns: '', kind: 'class', parent: null, line: 1, end: 1,
      loc: 1, code: 1, members: {}, memberList: [], bases: [], fanIn: 0, fanOut: 0, tags: [] }],
    edges: [], stats: {}, facets: { configFile: null, systems: [] },
  };
}
function server() {
  const state = { version: 'v1', value: bundle(), jsonError: false, status: 200, applied: [], errors: [] };
  state.fetch = async (url) => ({
    ok: state.status === 200, status: state.status,
    text: async () => url.startsWith('/web/') ? 'web1' : state.version,
    json: async () => { if (state.jsonError) throw new Error('temporary read failure'); return state.value; },
  });
  state.loader = createBundleLoader({ fetch: (...args) => state.fetch(...args),
    onBundle: (b) => state.applied.push(b.types[0].name), onError: (e) => state.errors.push(e) });
  return state;
}

test('contract rejects unsupported, malformed and dangling data; older optional fields may be absent', () => {
  assert.equal(validateBundle(bundle()).schema, 'code-atlas/1');
  const old = bundle(); old.generator.version = '1.4.2';
  assert.doesNotThrow(() => validateBundle(old));
  for (const edit of [b => { b.schema = 'code-atlas/2'; }, b => { b.files = null; },
    b => { b.types.push(b.types[0]); }, b => { b.types[0].file = 100; },
    b => { b.edges = [{ from: 0, to: 9 }]; }, b => { b.types[0].memberList = 'broken'; }]) {
    const value = bundle(); edit(value); assert.throws(() => validateBundle(value), /bundle/i);
  }
});

test('browser retries initial and update failures without committing bad versions', async () => {
  const s = server(); s.jsonError = true;
  await s.loader.poll(); assert.deepEqual(s.applied, []);
  s.jsonError = false; await s.loader.poll(); assert.deepEqual(s.applied, ['Alpha']);
  s.version = 'v2'; s.value = bundle('Bravo'); s.jsonError = true;
  await s.loader.poll(); s.jsonError = false;
  await s.loader.poll(); assert.deepEqual(s.applied, ['Alpha', 'Bravo']);
  s.version = 'v3'; s.value = { schema: 'unsupported' };
  await s.loader.poll(); assert.deepEqual(s.applied, ['Alpha', 'Bravo']);
  s.value = bundle('Recovered'); s.status = 503; await s.loader.poll();
  s.status = 200; await s.loader.poll(); assert.equal(s.applied.at(-1), 'Recovered');
});

test('browser retries application errors and changes during download', async () => {
  const s = server(); let throwOnce = true;
  const loader = createBundleLoader({ fetch: (...args) => s.fetch(...args), onBundle: (b) => {
    if (throwOnce) { throwOnce = false; throw new Error('render temporarily failed'); }
    s.applied.push(b.types[0].name);
  } });
  await loader.poll(); await loader.poll(); assert.deepEqual(s.applied, ['Alpha']);
  const original = s.fetch;
  s.version = 'v2'; s.value = bundle('Bravo');
  s.fetch = async (url) => { const response = await original(url); if (url.includes('bundle.json')) s.version = 'v3'; return response; };
  await loader.poll(); assert.deepEqual(s.applied, ['Alpha']);
  s.fetch = original; await loader.poll(); assert.deepEqual(s.applied, ['Alpha', 'Bravo']);
});

test('browser serializes polls and recovers after request timeout', async () => {
  let calls = 0, hanging = true;
  const s = server();
  const loader = createBundleLoader({ timeoutMs: 20, fetch: (_url, { signal }) => {
    if (!hanging) return s.fetch(_url);
    calls++;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  }, onBundle: (b) => s.applied.push(b.types[0].name) });
  const pending = loader.poll(); await loader.poll(); assert.equal(calls, 1); await pending;
  await loader.poll(); assert.equal(calls, 2);
  hanging = false; await loader.poll(); assert.deepEqual(s.applied, ['Alpha']);
});

test('atomic publication retries transient rename failures and preserves old data on failure', async () => {
  const file = path.join(work, 'atomic.json'); fs.writeFileSync(file, '{"old":true}');
  const rename = fs.renameSync; let attempts = 0;
  try {
    fs.renameSync = (...args) => {
      attempts++;
      if (attempts < 3) {
        assert.deepEqual(JSON.parse(fs.readFileSync(file)), { old: true });
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      }
      return rename(...args);
    };
    await writeJsonAtomic(file, { next: true }); assert.equal(attempts, 3);
    fs.renameSync = () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); };
    await assert.rejects(writeJsonAtomic(file, { corrupt: true }), /busy/);
    assert.deepEqual(readStableJson(file).value, { next: true });
    assert.equal(fs.readdirSync(work).some((name) => name.endsWith('.tmp')), false);
  } finally { fs.renameSync = rename; }
});

test('output lock rejects another writer and recovers after an abruptly killed writer', async () => {
  const out = path.join(work, 'locked');
  const source = `import {withOutputLock} from ${JSON.stringify(pathToFileURL(path.join(root, 'src/storage.mjs')).href)}; process.stdin.resume(); await withOutputLock(${JSON.stringify(out)}, async()=>{ console.log('LOCKED'); await new Promise(()=>{}); });`;
  const child = spawn(node, ['--input-type=module', '-e', source], { windowsHide: true });
  let ready = ''; child.stdout.on('data', (chunk) => { ready += chunk; });
  // Keep the child event loop alive while the lock is held.
  child.stdin.on('error', () => {});
  try {
    await waitFor(() => ready.includes('LOCKED'), 'writer lock');
    await assert.rejects(withOutputLock(out, async () => {}), /already being scanned/);
  } finally { child.kill(); await waitFor(() => child.exitCode !== null || child.signalCode !== null, 'writer exit'); }
  await withOutputLock(out, async () => writeJsonAtomic(path.join(out, 'bundle.json'), { recovered: true }));
  assert.deepEqual(readStableJson(path.join(out, 'bundle.json')).value, { recovered: true });
});

test('release sources are explicit even without Git; private configs require opt-in', () => {
  fs.mkdirSync(path.join(work, 'configs'), { recursive: true });
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.writeFileSync(path.join(work, 'configs/private.facets.json'), '{}');
  fs.writeFileSync(path.join(work, 'src/.o-private.mjs'), 'local only');
  const files = payloadSourceFiles(work);
  assert.ok(files.includes('shared/bundle-contract.mjs'));
  assert.ok(!files.some((file) => /private/.test(file)));
  assert.ok(payloadSourceFiles(work, { allConfigs: true }).includes('configs/private.facets.json'));
});

test('MCP keeps the last valid graph, warns, and reloads a repaired same-mtime bundle', async () => {
  const out = path.join(work, 'mcp'); fs.mkdirSync(out);
  const file = path.join(out, 'bundle.json'); fs.writeFileSync(file, JSON.stringify(bundle()));
  const child = spawn(node, [path.join(root, 'src/cli.mjs'), 'mcp', '--out', out], { windowsHide: true });
  let output = '', errors = ''; const replies = new Map(); let next = 0;
  child.stderr.on('data', (chunk) => { errors += chunk; });
  child.stdout.on('data', (chunk) => {
    output += chunk; let nl;
    while ((nl = output.indexOf('\n')) >= 0) { const reply = JSON.parse(output.slice(0, nl)); replies.set(reply.id, reply); output = output.slice(nl + 1); }
  });
  const search = async (query) => {
    const id = ++next;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'search', arguments: { query } } }) + '\n');
    await waitFor(() => replies.has(id), `MCP search ${errors}`);
    return replies.get(id).result.content[0].text;
  };
  try {
    assert.match(await search('Alpha'), /Alpha/);
    fs.writeFileSync(file, '{'); fs.utimesSync(file, new Date(0), new Date(0));
    assert.match(await search('Alpha'), /last valid snapshot|上一份有效快照/);
    const repaired = bundle('Bravo'); fs.writeFileSync(file, JSON.stringify(repaired)); fs.utimesSync(file, new Date(0), new Date(0));
    assert.match(await search('Bravo'), /Bravo/);
    const invalid = bundle(); invalid.schema = 'code-atlas/99'; fs.writeFileSync(file, JSON.stringify(invalid));
    assert.match(await search('Bravo'), /last valid snapshot|上一份有效快照/);
  } finally { child.kill(); }
  fs.writeFileSync(file, '{"schema":"code-atlas/99"}');
  const failed = spawnSync(node, [path.join(root, 'src/cli.mjs'), 'mcp', '--out', out], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /Unsupported bundle schema/);
});
