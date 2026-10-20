import test from 'node:test';
import assert from 'node:assert/strict';
import { createUnresolvedDetails, queryUnresolved } from '../src/unresolved.mjs';
const bundle = (details) => ({ files: [{ id: 0, path: 'src/A.cs' }, { id: 1, path: 'tests/B.cs' }],
  unresolved: { unknown: 4, ambiguous: 1 }, stats: { unresolved: { details } } });

test('diagnostic caps keep counts honest, including repeated retained keys and long identifiers', () => {
  const c = createUnresolvedDetails(2);
  c.record(0, 'csharp', 'A', 'unknown'); c.record(0, 'csharp', 'A', 'unknown');
  c.record(1, 'csharp', 'B', 'ambiguous'); c.record(0, 'csharp', 'C', 'unknown');
  c.record(0, 'csharp', 'A', 'unknown'); c.record(0, 'csharp', 'X'.repeat(513), 'unknown');
  assert.deepEqual(c.snapshot(), { entries: [{ file: 0, lang: 'csharp', name: 'A', kind: 'unknown', reason: 'unknown', n: 3 },
    { file: 1, lang: 'csharp', name: 'B', kind: 'ambiguous', reason: 'ambiguous', n: 1 }], limit: 2, dropped: 2, truncated: true });
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
});

test('corrupt optional diagnostics fail clearly instead of producing false rankings', () => {
  const c = createUnresolvedDetails(); c.record(0, 'csharp', 'A', 'unknown');
  const b = bundle(c.snapshot()); b.stats.unresolved.details.entries[0].n = '100';
  assert.throws(() => queryUnresolved(b), /Invalid unresolved details/);
});
