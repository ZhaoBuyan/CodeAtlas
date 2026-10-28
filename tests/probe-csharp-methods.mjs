import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});
const out=fs.mkdtempSync(path.join(root,'tests/.out/csharp-methods-'));
function scan(warm=false){
  const p=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/csharp-method-declarations'),'--lang','csharp','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});
  assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));
}
const a=scan(),b=scan(true);assert.equal(a.types.length,11);assert.equal(a.totals.parseErrors,0);
for(const key of ['files','types','edges'])assert.deepEqual(a[key],b[key],`cold/warm ${key}`);
const type=name=>{const t=a.types.find(t=>t.fqn===`MethodRoles.${name}`);assert.ok(t,name);return t;};
const edge=(from,to,kind='ref')=>a.edges.find(e=>e.from===type(from).id&&e.to===type(to).id&&e.kind===kind);
for(const from of ['Declaration','Signature','Generic'])assert.ok(!edge(from,'Collision'),from);
for(const [from,to,w]of [['Combined','Collision',2],['Explicit','Collision',2],['IContract','Collision',1],['Genuine','Kept',2],['Signature','Kept',1],['Extensions','Collision',2],['Reflected','Collision',1]])assert.equal(edge(from,to)?.w,w,`${from}->${to}`);
assert.equal(edge('Explicit','IContract')?.w,2);
assert.equal(edge('Explicit','IContract','inherit')?.w,1);
assert.equal(edge('Combined','Collision').tier,'import');assert.equal(edge('IContract','Collision').tier,'same');
for(const name of ['Declaration','Signature','Generic']){
 assert.ok(type(name).memberList.some(m=>m.n==='Collision'),`member retained ${name}`);
 assert.ok(!type(name).uses?.some(u=>u.n==='Collision'),`declaration use removed ${name}`);
}
console.log('C# methods: declaration false edges absent; return/body, explicit interfaces, generic members, extension parameters, typeof and cold/warm preserved.');
