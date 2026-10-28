import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});
const work=fs.mkdtempSync(path.join(root,'tests/.out/elm-'));
const fixture=path.join(root,'tests/fixtures/elm');
function scan(source,out,warm=false){
  const r=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',source,'--lang','elm','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));
}
const out=path.join(work,'cold-warm'),cold=scan(fixture,out),warm=scan(fixture,out,true);
assert.equal(cold.files.length,16);assert.equal(cold.types.length,28);assert.equal(cold.totals.parseErrors,0);
for(const key of ['files','types','edges'])assert.deepEqual(cold[key],warm[key],`cold/warm ${key}`);
const type=(b,fqn)=>{const found=b.types.find(t=>t.fqn===fqn);assert.ok(found,`missing ${fqn}`);return found;};
const edge=(b,from,to)=>b.edges.find(e=>e.from===type(b,from).id&&e.to===type(b,to).id);
for(const [from,to,w,tier]of [
 ['User.Model','Alpha.Public',2,'import'],['User.Model','Alpha.Alias',1,'import'],['User.Model','Shadow.Int',1,'import'],
 ['User.Extended','Alpha.Public',1,'import'],['AllUser.Kept','All.Available',1,'import'],
 ['Alpha.Choice','Alpha.Public',1,'same'],['Alpha.elm','Alpha.Hidden',1,'same'],
 ['Main.DefaultMain','Alpha.Public',1,'import'],['Ports.elm','Ports.Payload',1,'same'],
 ['BarrelUser.Kept','Barrel.Other',1,'import'],['User.elm','Alpha.Public',1,'import'],
]){const e=edge(cold,from,to);assert.equal(e?.w,w,`${from}->${to}`);assert.equal(e.tier,tier);}
for(const from of ['User.NegativePrefix','User.NegativeHidden','Collision.Conflict','External.Uncertain',
 'DuplicateUser.Rejected','BarrelUser.CannotReexport','Implicit.Defaults','ConstructorOnly.elm'])
 assert.equal(cold.edges.filter(e=>e.from===type(cold,from).id).length,0,from);
assert.ok(!edge(cold,'User.Model','Alpha.Hidden'));
assert.ok(!edge(cold,'User.Model','Shadow.Public'));
assert.ok(type(cold,'Alpha.Public').memberList.some(m=>m.k==='ctor'&&m.n==='Public'));
assert.ok(type(cold,'User.Model').memberList.some(m=>m.k==='field'&&m.n==='qualified'));
assert.ok(type(cold,'User.elm').memberList.some(m=>m.k==='function'&&m.n==='run'));
assert.ok(type(cold,'Ports.elm').memberList.some(m=>m.k==='port'&&m.n==='send'));
assert.ok(type(cold,'User.Model').uses.some(u=>u.q==='A.Public'&&u.c===0));
assert.ok(cold.stats.unresolved.ambiguous>=2&&cold.stats.unresolved.unknown>0);
// Source-only counterfactuals: the exact previously rejected reference becomes supported.
const changed=path.join(work,'changed');fs.cpSync(fixture,changed,{recursive:true});
const alpha=path.join(changed,'Alpha.elm');fs.writeFileSync(alpha,fs.readFileSync(alpha,'utf8').replace('(Public, Choice','(Hidden, Public, Choice'));
const exported=scan(changed,path.join(work,'exported'));
assert.equal(edge(exported,'User.NegativeHidden','Alpha.Hidden')?.tier,'import');
const user=path.join(changed,'User.elm');fs.writeFileSync(user,fs.readFileSync(user,'utf8').replace('import Alpha as A exposing','import Alpha exposing'));
const renamed=scan(changed,path.join(work,'renamed'));
assert.equal(edge(renamed,'User.NegativePrefix','Alpha.Public')?.tier,'import');
assert.equal(renamed.edges.filter(e=>e.from===type(renamed,'User.NegativeHidden').id).length,0);
// A syntax error makes both the source and its exports uncertain, without guessing.
const malformed=path.join(work,'malformed');fs.mkdirSync(malformed);
fs.writeFileSync(path.join(malformed,'Good.elm'),'module Good exposing (Value)\ntype Value = Value\n');
fs.writeFileSync(path.join(malformed,'Bad.elm'),'module Bad exposing (Hidden)\nimport Good\ntype Hidden = Hidden\ntype alias WouldConnect = Good.Value\nbroken = (\n');
fs.writeFileSync(path.join(malformed,'Use.elm'),'module Use exposing (..)\nimport Bad\ntype alias Blocked = Bad.Hidden\n');
const bad=scan(malformed,path.join(work,'bad-out'));
assert.ok(bad.totals.parseErrors>0);assert.ok(bad.files.find(f=>f.path==='Bad.elm').symbolScope.malformed);
assert.equal(bad.edges.length,0);assert.ok(bad.stats.unresolved.unknown>0);
console.log(`Elm scopes passed: ${cold.files.length} files, ${cold.types.length} nodes; exact imports/exports, aliases, defaults, ambiguity, source counterfactuals, malformed files and cold/warm checked.`);
