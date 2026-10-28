import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});
const out=fs.mkdtempSync(path.join(root,'tests/.out/scala-declarations-'));
function scan(warm){
  const run=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/scala-method-declarations'),'--lang','scala','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(run.status,0,run.stdout+run.stderr);
  return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));
}
const cold=scan(false),warm=scan(true);
assert.equal(cold.totals.parseErrors,0);
for(const key of ['files','types','edges'])assert.deepEqual(cold[key],warm[key],`cold/warm ${key}`);
const type=name=>{const t=cold.types.find(t=>t.fqn===`methodroles.${name}`);assert.ok(t,name);return t;};
const edge=(from,to)=>cold.edges.find(e=>e.from===type(from).id&&e.to===type(to).id);
assert.ok(!edge('Declaration','Collision'));
assert.ok(!edge('Signature','Collision'));
assert.equal(edge('Combined','Collision')?.w,2);
assert.equal(edge('Genuine','Kept')?.w,2);
assert.equal(edge('Signature','Kept')?.w,1);
assert.ok(type('Declaration').memberList.some(m=>m.n==='Collision'));
assert.ok(!type('Declaration').uses?.some(u=>u.n==='Collision'));
assert.ok(!type('Signature').uses?.some(u=>u.n==='Collision'));
console.log('Scala: definition/signature names excluded, return/body references and members preserved, cold/warm equal.');
