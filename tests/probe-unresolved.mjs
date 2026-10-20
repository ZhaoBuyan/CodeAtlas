import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnresolvedDetails, queryUnresolved } from '../src/unresolved.mjs';
const bundle = (details) => ({ files: [{ id: 0, path: 'src/A.cs' }, { id: 1, path: 'tests/B.cs' }],
  unresolved: { unknown: 4, ambiguous: 1 }, stats: { unresolved: { details } } });

test('diagnostic caps keep counts honest, including repeated retained keys and long identifiers', () => {
  const c = createUnresolvedDetails({ ambiguous: 1, unknown: 1 });
  c.record(0, 'csharp', 'A', 'unknown'); c.record(0, 'csharp', 'A', 'unknown');
  c.record(1, 'csharp', 'B', 'ambiguous'); c.record(0, 'csharp', 'C', 'unknown');
  c.record(0, 'csharp', 'A', 'unknown'); c.record(0, 'csharp', 'X'.repeat(513), 'unknown');
  assert.deepEqual(c.snapshot(), { entries: [{ file: 0, lang: 'csharp', name: 'A', kind: 'unknown', reason: 'unknown', n: 3 },
    { file: 1, lang: 'csharp', name: 'B', kind: 'ambiguous', reason: 'ambiguous', n: 1 }], limit: 2,
    limits: { ambiguous: 1, unknown: 1 }, droppedByKind: { ambiguous: 0, unknown: 2 }, dropped: 2, truncated: true });
});

test('filter before ranking; combine source files without changing the snapshot', () => {
  const c = createUnresolvedDetails();
  for (let i = 0; i < 3; i++) c.record(0, 'csharp', 'A', 'unknown', 'csharp-member-global');
  c.record(1, 'csharp', 'A', 'unknown', 'csharp-member-global'); c.record(1, 'javascript', 'B', 'ambiguous');
  const b = bundle(c.snapshot()), saved = JSON.stringify(b);
  assert.equal(queryUnresolved(b).top[0].n, 4);
  assert.equal(queryUnresolved(b).top[0].fileCount, 2);
  const q = queryUnresolved(b, { file: 'TESTS\\B.CS', lang: 'CSHARP', limit: 1 });
  assert.equal(q.matched, 1); assert.equal(q.top[0].n, 1); assert.deepEqual(q.top[0].files, ['tests/B.cs']);
  assert.equal(queryUnresolved(b, { lang: 'rust' }).matched, 0);
  assert.equal(JSON.stringify(b), saved);
  for (const limit of [0, -1, 101, 1.5]) assert.throws(() => queryUnresolved(b, { limit }), /limit/);
});

test('legacy snapshots never fabricate file details from global top names', () => {
  const b = bundle(undefined); b.stats.unresolved.topNames = [{ lang: 'csharp', name: 'FakeSource', n: 90 }];
  assert.deepEqual(queryUnresolved(b, { file: 'A.cs' }), { available: false, totals: b.unresolved });
  assert.equal(queryUnresolved({ files: [], stats: {} }).totals, null);
  const c = createUnresolvedDetails(); c.record(0, 'csharp', 'Old', 'ambiguous');
  const legacy = c.snapshot(); delete legacy.limits; delete legacy.droppedByKind;
  const q = queryUnresolved(bundle(legacy));
  assert.equal(q.available, true); assert.equal(q.matched, 1);
  assert.equal(q.droppedByKind, undefined, 'old details must not fabricate per-kind coverage');
});

test('corrupt optional diagnostics fail clearly instead of producing false rankings', () => {
  const c = createUnresolvedDetails(); c.record(0, 'csharp', 'A', 'unknown');
  const b = bundle(c.snapshot()); b.stats.unresolved.details.entries[0].n = '100';
  assert.throws(() => queryUnresolved(b), /Invalid unresolved details/);
});

test('unknown flood never consumes ambiguous quota; both limits and per-kind accounting remain bounded', () => {
  const c = createUnresolvedDetails();
  for (let i = 0; i < 344948; i++) c.record(0, 'csharp', `Unknown${i}`, 'unknown');
  for (let i = 0; i < 13001; i++) c.record(1, 'csharp', `Ambiguous${i}`, 'ambiguous');
  const d = c.snapshot();
  assert.equal(d.entries.filter(r => r.kind === 'unknown').length, 1000);
  assert.equal(d.entries.filter(r => r.kind === 'ambiguous').length, 13001);
  assert.deepEqual(d.droppedByKind, { unknown: 343948, ambiguous: 0 });
  assert.equal(d.entries.reduce((n, r) => n + r.n, 0) + d.dropped, 344948 + 13001);
  const tiny = createUnresolvedDetails({ unknown: 0, ambiguous: 1 });
  tiny.record(0, 'csharp', 'A', 'ambiguous'); tiny.record(0, 'csharp', 'B', 'ambiguous');
  tiny.record(0, 'csharp', 'A', 'ambiguous'); tiny.record(0, 'csharp', 'U', 'unknown');
  tiny.record(0, 'csharp', 'X'.repeat(513), 'ambiguous');
  const snapshot = tiny.snapshot();
  assert.equal(snapshot.entries[0].n, 2);
  assert.deepEqual(snapshot.droppedByKind, { ambiguous: 2, unknown: 1 });
  snapshot.droppedByKind.ambiguous = 999;
  assert.equal(tiny.snapshot().droppedByKind.ambiguous, 2);
  assert.throws(() => queryUnresolved(bundle(snapshot)), /Invalid unresolved details/);
});
