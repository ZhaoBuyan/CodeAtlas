import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root, 'tests/.out'), { recursive: true });
const out = fs.mkdtempSync(path.join(root, 'tests/.out/haskell-'));
function scan(incremental = false) {
  const run = spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), 'scan', path.join(root, 'tests/fixtures/haskell'),
    '--lang', 'haskell', '--out', out, ...(incremental ? ['--incremental'] : [])], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return JSON.parse(fs.readFileSync(path.join(out, 'bundle.json')));
}
const cold = scan(), warm = scan(true);
assert.equal(cold.totals.parseErrors, 0);
for (const key of ['files', 'types', 'edges']) assert.ok(JSON.stringify(cold[key]) === JSON.stringify(warm[key]), `cold/warm ${key}`);
const edge = (from, to) => cold.edges.find(e => cold.types[e.from].fqn === from && cold.types[e.to].fqn === to);
for (const from of ['Atlas.Use.Qualified', 'Atlas.Use.Holder', 'Atlas.Bare.Kept', 'Atlas.Bare.Wrapped', 'Atlas.Reexport.ThroughBarrel']) {
  const e = edge(from, 'Atlas.Dep.Box'); assert.ok(e, from); assert.equal(e.tier, 'import'); assert.equal(e.w, 1);
}
for (const from of ['Atlas.Use.MissingAlias', 'Atlas.Use.BareNotImported', 'Atlas.Use.NotSelected', 'Atlas.Use.Private',
  'Atlas.Bare.Hidden', 'Atlas.Reexport.StillPrivate', 'Atlas.NoImport.Unrelated', 'Atlas.NoImport.WrongModule']) {
  const t = cold.types.find(t => t.fqn === from); assert.ok(t, from);
  assert.equal(cold.edges.filter(e => e.from === t.id).length, 0, from);
}
assert.equal(edge('Atlas.Other.Local', 'Atlas.Other.Coincidence')?.tier, 'same');
assert.equal(edge('Atlas.ExportsUse.ViaSelf', 'Atlas.SelfExport.SelfBox')?.tier, 'import');
assert.equal(edge('Atlas.ExportsUse.ViaQualified', 'Atlas.Dep.Box')?.tier, 'import');
assert.equal(edge('Atlas.ExportsUse.ViaSplit', 'Atlas.Dep.Box')?.tier, 'import');
assert.equal(edge('Atlas.Family.StillQualified', 'Atlas.Dep.Shown')?.tier, 'import');
for (const name of ['Atlas.PreludeCollision.QualifiedMaybe', 'Atlas.NoPrelude.ExplicitMaybe', 'Atlas.HiddenPrelude.ExplicitMaybe'])
  assert.equal(edge(name, 'Atlas.Dep.Maybe')?.tier, 'import', name);
assert.equal(edge('Atlas.Ambiguous.LocalQualified', 'Atlas.Ambiguous.Box')?.tier, 'same');
for (const name of ['Atlas.Ambiguous.Collision', 'Atlas.ImplicitUse.ImplicitHidden',
  'Atlas.Package.AmbiguousPackage', 'Atlas.Conditional.Unselected', 'Atlas.ConditionalUse.NoChosenBranch',
  'Atlas.Family.Associated', 'Atlas.Family.UnresolvedFamily', 'Atlas.PreludeCollision.AmbiguousMaybe']) {
  const t = cold.types.find(t => t.fqn === name); assert.ok(t, name);
  assert.equal(cold.edges.filter(e => e.from === t.id).length, 0, name);
}
assert.ok(!cold.types.some(t => t.name === 'Phantom'));
for (const t of cold.types) for (const value of Object.values(t.members)) assert.ok(Number.isInteger(value) && value >= 0);
assert.ok(cold.stats.unresolved.details.entries.some(e => e.reason === 'haskell-preprocessing-unresolved'));
assert.ok(cold.types.some(t => t.memberList.some(m => m.n === 'helper' && m.k === 'function')));
assert.ok(cold.stats.unresolved.unknown > 0);
console.log('Haskell module scopes: positive/negative edges, exports, aliases, hiding, barrel and cold/warm passed.');
