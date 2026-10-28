import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
fs.mkdirSync(path.join(root,'tests/.out'), {recursive:true});
const out = fs.mkdtempSync(path.join(root,'tests/.out/clojure-'));
function scan(warm=false) {
  const r=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/clojure'),'--lang','clojure','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(r.status,0,r.stdout+r.stderr); return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));
}
const cold=scan(), warm=scan(true);
assert.equal(cold.totals.parseErrors,0);
for(const key of ['files','types','edges']) assert.ok(JSON.stringify(cold[key])===JSON.stringify(warm[key]),`cold/warm ${key}`);
const type=fqn=>{const t=cold.types.find(t=>t.fqn===fqn);assert.ok(t,`missing ${fqn}`);return t;};
const edge=(from,to)=>cold.edges.find(e=>e.from===type(from).id&&e.to===type(to).id);
for(const from of ['atlas.use.ViaAlias','atlas.use.ViaRefer','atlas.use.ViaNamespace','atlas.renamed.RenamedUser','atlas.wildcard.WildUser','atlas.prefix.PrefixUser'])
  assert.equal(edge(from,'atlas.types.Contract')?.tier,'import',from);
assert.equal(edge('atlas.use.ViaAlias','atlas.types.Box')?.w,1);
assert.equal(edge('atlas.use.ViaAlias','atlas.types.Item')?.w,1);
assert.equal(edge('atlas.hyphen-use.HyphenUser','atlas.hyphen-types.HyphenBox')?.tier,'import');
assert.equal(edge('atlas.protocol-class.ValidImplementation','atlas.protocol-class.LocalContract')?.tier,'same');
assert.equal(edge('atlas.defaults.QualifiedDefault','atlas.defaults.String')?.tier,'same');
for(const from of ['atlas.negative.NoRefer','atlas.negative.AliasIsNotClass','atlas.negative.HiddenUser',
  'atlas.renamed.OldName','atlas.unknown-wildcard.UnknownWild','atlas.rebinding.Rebound','atlas.protocol-class.ProtocolHint','atlas.defaults.FalseDefault',
  'atlas.redefined-use.ReplacedUser'])
  assert.equal(cold.edges.filter(e=>e.from===type(from).id).length,0,from);
for(const name of ['Quoted','Discarded','Generated','Commented','NotAType']) assert.ok(!cold.types.some(t=>t.name===name),name);
assert.ok(cold.types.some(t=>t.fqn==='atlas.shadow-macro.ExplicitType'));
assert.ok(cold.files.some(f=>f.symbolScope?.unsupported.some(e=>e.kind==='runtime-namespace-operation')));
assert.ok(cold.stats.unresolved.unknown>0);
for(const t of cold.types) for(const n of Object.values(t.members)) assert.ok(Number.isInteger(n));
const cache=JSON.parse(fs.readFileSync(path.join(out,'.scan-cache.json')));
const refs=Object.values(cache.files).flatMap(f=>f.part.refs);
assert.ok(refs.some(r=>r.role==='clojure-class'&&r.q==='Box'));
assert.ok(refs.some(r=>r.role==='clojure-implementation'&&r.q==='t/Contract'));
assert.ok(type('atlas.use.ViaAlias').uses.some(u=>u.q==='t/Contract'&&u.role==='clojure-implementation'&&u.c===0));
assert.ok(type('atlas.use.ViaAlias').uses.some(u=>u.q==='Item.'&&u.role==='clojure-class'&&u.c===1));
assert.ok(cold.files.some(f=>f.uses?.some(u=>u.q==='Box'&&u.role==='clojure-class')));
console.log(`Clojure scopes passed: ${cold.files.length} files, ${cold.types.length} nodes; imports, protocols/classes, aliases, privacy, inert syntax and cold/warm checked.`);
