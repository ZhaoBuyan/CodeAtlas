import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {spawn,spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});const out=fs.mkdtempSync(path.join(root,'tests/.out/csharp-calls-'));
function scan(warm=false){const p=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/csharp-call-roles'),'--lang','csharp','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(p.status,0,p.stdout+p.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));}
const a=scan(),b=scan(true);assert.equal(a.types.length,12);assert.equal(a.edges.length,9);assert.equal(a.totals.parseErrors,0);
for(const key of ['files','types','edges'])assert.deepEqual(a[key],b[key],`cold/warm ${key}`);
const type=name=>{const t=a.types.find(t=>t.fqn===`CallRoles.${name}`);assert.ok(t,name);return t;};
const edge=(from,to,kind='ref')=>a.edges.find(e=>e.from===type(from).id&&e.to===type(to).id&&e.kind===kind);
for(const[from,to]of [['BareOnly','Collision'],['GenericOnly','GenericCollision'],['TypeArguments','GenericCollision']])assert.ok(!edge(from,to));
for(const[from,to,w]of [['Mixed','Collision',2],['TypeArguments','Token',3],['TypedUses','Collision',3],['TypedUses','Token',1],['GenericType','GenericCollision',2],['GenericType','Token',2],['DerivedCallback','Callback',1]])assert.equal(edge(from,to)?.w,w,`${from}->${to}`);
assert.equal(edge('DerivedCallback','CallbackOwner','inherit')?.w,1);
assert.ok(type('BareOnly').uses.some(u=>u.n==='Collision'&&u.c===1&&u.role==='csharp-callable'));
assert.ok(type('Mixed').uses.some(u=>u.n==='Collision'&&u.c===1&&!u.role));
const cache=JSON.parse(fs.readFileSync(path.join(out,'.scan-cache.json')));
assert.ok(Object.values(cache.files).some(f=>f.part.refs.some(r=>r.name==='GenericCollision'&&r.role==='csharp-callable')));
assert.ok(a.stats.unresolved.details.entries.some(e=>e.reason==='csharp-callable-not-type'));
// The type edge is rejected, but the actual method call must stay queryable through MCP.
const child=spawn(process.execPath,[path.join(root,'src/cli.mjs'),'mcp','--out',out],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});
let seq=0,buffer='';const pending=new Map();
child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;const message=JSON.parse(line);pending.get(message.id)?.(message);pending.delete(message.id);}});
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`MCP timeout ${method}`));},10000);pending.set(id,message=>{clearTimeout(timer);if(message.error)reject(new Error(JSON.stringify(message.error)));else resolve(message.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try{
 await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'csharp-call-role-test',version:'1'}});
 const result=await request('tools/call',{name:'refs',arguments:{name:'CallRoles.BareOnly.Collision'}});assert.ok(!result.isError);const text=result.content.map(c=>c.text||'').join('\n');assert.ok(text.includes('Owners.cs:5'),text);
}finally{child.kill();}
console.log('C# calls: non-delegate type edges rejected; call sites/MCP, delegate edges, type arguments, constructors, patterns, typeof/nameof and cold/warm preserved.');
