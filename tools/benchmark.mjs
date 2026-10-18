/** Generated workloads only; no existing sample repositories are scanned. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../src/mcp.mjs';
import { topTypes, createVisibleTypeCache } from '../web/query-model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => args.includes(name) ? args[args.indexOf(name) + 1] : fallback;
const sizes = String(option('--sizes', args.includes('--quick') ? '50,200' : '100,500')).split(',').map(Number);
const samples = Number(option('--samples', '2'));
if (!sizes.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 10000) || !Number.isSafeInteger(samples) || samples < 1 || samples > 10) throw new Error('Invalid benchmark sizes/samples');
const output = path.resolve(root, option('--out', 'build/benchmarks/latest.json'));
const work = path.join(root, 'build/benchmarks', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(work, { recursive: true });
const node = process.env.NODE_BIN || process.execPath;
const cli = path.join(root, 'src/cli.mjs');
const median = (values) => { const sorted = values.slice().sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

function scan(input, out, incremental) {
  const start = performance.now();
  const result = spawnSync(node, [cli, 'scan', input, '--out', out, '--lang', 'javascript,python', '--profile', ...(incremental ? ['--incremental'] : [])],
    { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr + result.stdout);
  const wallMs = performance.now() - start;
  const bundle = JSON.parse(fs.readFileSync(path.join(out, 'bundle.json'), 'utf8'));
  assert.equal(bundle.source.failedLanguages?.length || 0, 0);
  return { wallMs, bundle, bytes: fs.statSync(path.join(out, 'bundle.json')).size,
    profile: JSON.parse(fs.readFileSync(path.join(out, 'scan-profile.json'), 'utf8')) };
}

async function mcp(out) {
  const child = spawn(node, [cli, 'mcp', '--out', out], { cwd: root, windowsHide: true });
  let buffer = '', id = 0; const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk; let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
      const request = pending.get(message.id); if (request) { pending.delete(message.id); request.resolve(message); }
    }
  });
  child.stderr.resume();
  const request = (method, params) => new Promise((resolve, reject) => {
    const key = ++id; const timer = setTimeout(() => reject(new Error('MCP benchmark timed out')), 10000);
    pending.set(key, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  try {
    const started = performance.now(); await request('initialize', {});
    const startupAndInitializeMs = performance.now() - started;
    const timings = [];
    for (let i = 0; i < 6; i++) {
      const begin = performance.now(); const result = await request('tools/call', { name: 'overview', arguments: {} });
      assert.equal(result.result.isError, false); timings.push(performance.now() - begin);
    }
    return { startupAndInitializeMs, firstOverviewMs: timings[0], warmOverviewMedianMs: median(timings.slice(1)) };
  } finally { child.kill(); }
}

const scans = [];
for (const size of sizes) {
  const input = path.join(work, `generated-${size}`); fs.mkdirSync(input);
  for (let i = 0; i < size; i++) {
    const js = i % 2 === 0;
    fs.writeFileSync(path.join(input, `f${i}.${js ? 'js' : 'py'}`), js
      ? `${i >= 2 ? `import { Item${i - 2} } from './f${i - 2}.js';\n` : ''}export class Item${i}${i >= 2 ? ` extends Item${i - 2}` : ''} { value() { return ${i}; } }\n`
      : `class Item${i}:\n    def value(self):\n        return ${i}\n`);
  }
  for (let sample = 0; sample < samples; sample++) {
    const out = path.join(work, `out-${size}-${sample}`);
    const cold = scan(input, out, false), warm = scan(input, out, true);
    assert.deepEqual(warm.bundle.types, cold.bundle.types); assert.deepEqual(warm.bundle.edges, cold.bundle.edges);
    assert.equal(warm.profile.reparsed, 0); assert.equal(warm.profile.reused, size);
    fs.appendFileSync(path.join(input, 'f0.js'), '// benchmark change\n');
    const changed = scan(input, out, true); assert.equal(changed.profile.reparsed, 1);
    const indexStart = performance.now(); buildIndex(changed.bundle); const indexMs = performance.now() - indexStart;
    const query = await mcp(out);
    for (const [scenario, result] of [['cold', cold], ['unchanged', warm], ['one-file-change', changed]]) {
      scans.push({ files: size, sample, scenario, wallMs: result.wallMs, bytes: result.bytes, ...result.profile,
        ...(scenario === 'one-file-change' ? { indexMs, mcp: query } : {}) });
    }
    console.log(`Benchmark ${size} files #${sample + 1}: cold ${cold.wallMs.toFixed(0)}ms; unchanged ${warm.wallMs.toFixed(0)}ms; one file ${changed.wallMs.toFixed(0)}ms`);
  }
}

const ranking = [];
for (const count of [1000, 10000, 50000]) {
  let seed = 314159;
  const types = Array.from({ length: count }, (_, id) => ({ id, code: (seed = (seed * 1664525 + 1013904223) >>> 0) % 100000,
    members: { method: id % 17, property: id % 13 } }));
  for (const metric of ['code', 'members']) {
    const score = metric === 'code' ? (t) => t.code || 1 : (t) => Object.values(t.members).reduce((a, b) => a + b, 0) || 1;
    const before = [], after = [];
    for (let i = 0; i < 12; i++) {
      let started = performance.now(); const sorted = types.slice().sort((a, b) => score(b) - score(a)).slice(0, 12);
      const oldMs = performance.now() - started;
      started = performance.now(); const bounded = topTypes(types, score, 12); const newMs = performance.now() - started;
      assert.deepEqual(bounded.map((t) => t.id), sorted.map((t) => t.id));
      if (i >= 2) { before.push(oldMs); after.push(newMs); }
    }
    ranking.push({ count, metric, fullSortMedianMs: median(before), boundedMedianMs: median(after) });
  }
  const state = { bundle: { types }, kinds: new Set(['class']), langs: null, q: '', minCode: 0, hideGenerated: false, depFocus: false, selected: null };
  const cached = createVisibleTypeCache(); const start = performance.now(); cached(state, () => true);
  const firstFilterMs = performance.now() - start; const warm = [];
  for (let i = 0; i < 30; i++) { const t = performance.now(); cached(state, () => true); warm.push(performance.now() - t); }
  ranking.push({ count, metric: 'visible-cache', firstFilterMs, repeatedFilterMedianMs: median(warm) });
}
const report = { generated: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, memoryGiB: os.totalmem() / 2 ** 30 },
  methodology: 'Application-cold scans, not OS-cache-cold; generated JS/Python inputs. RSS is per process, not summed. UI timings cover data helpers, not DOM/layout/FPS.',
  work, scans, ranking };
fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
const rows = ['# Code Atlas 性能基线', '', report.methodology, '', '| 文件数 | 场景 | 进程总耗时中位数 ms |', '| --- | --- | --- |'];
for (const size of sizes) for (const scenario of ['cold', 'unchanged', 'one-file-change']) rows.push(`| ${size} | ${scenario} | ${median(scans.filter((r) => r.files === size && r.scenario === scenario).map((r) => r.wallMs)).toFixed(2)} |`);
rows.push('', '| 类型数 | 排名指标 | 全量排序 ms | Top-N ms |', '| --- | --- | --- | --- |');
for (const row of ranking.filter((r) => r.metric !== 'visible-cache')) rows.push(`| ${row.count} | ${row.metric} | ${row.fullSortMedianMs.toFixed(3)} | ${row.boundedMedianMs.toFixed(3)} |`);
fs.writeFileSync(output.replace(/\.json$/, '') + '.md', rows.join('\n') + '\n');
console.log(`Benchmark report: ${output}`);
