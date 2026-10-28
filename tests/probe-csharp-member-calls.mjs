import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{spawn,spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});const out=fs.mkdtempSync(path.join(root,'tests/.out/csharp-member-calls-'));
function scan(warm=false){const r=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/csharp-member-call-roles'),'--lang','csharp','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));}
const a=scan(),b=scan(true);assert.equal(a.types.length,16);assert.equal(a.edges.length,14);assert.equal(a.totals.parseErrors,0);for(const key of['files','types','edges'])assert.deepEqual(a[key],b[key],`cold/warm ${key}`);
const type=name=>{const t=a.types.find(t=>t.fqn===`MemberCallRoles.${name}`);assert.ok(t,name);return t;};
const edge=(from,to,kind='ref')=>a.edges.find(e=>e.from===type(from).id&&e.to===type(to).id&&e.kind===kind);
for(const[from,to]of[['StaticOnly','Collision'],['GenericOnly','GenericCollision'],['ConditionalOnly','Collision'],['TypeArguments','GenericCollision']])assert.ok(!edge(from,to),`${from}->${to}`);
for(const[from,to,w]of[['StaticOnly','Provider',1],['Mixed','Collision',2],['Mixed','Provider',1],['TypeArguments','Token',3],['NestedType','Provider',3],['NestedType','Nested',3],['QualifiedType','Token',1],['InheritedCallback','Callback',1]])assert.equal(edge(from,to)?.w,w,`${from}->${to}`);
assert.equal(edge('InheritedCallback','DelegateProvider','inherit')?.w,1);
assert.ok(type('StaticOnly').uses.some(u=>u.n==='Collision'&&u.c===1&&u.role==='csharp-callable'));
assert.ok(type('TypeArguments').uses.some(u=>u.n==='GenericCollision'&&u.role==='csharp-callable'));
assert.ok(type('ConditionalOnly').uses.some(u=>u.n==='Collision'&&u.role==='csharp-callable'));
assert.ok(a.stats.unresolved.details.entries.some(e=>e.reason==='csharp-callable-not-type'));
const child=spawn(process.execPath,[path.join(root,'src/cli.mjs'),'mcp','--out',out],{cwd:root,stdio:['pipe','pipe','pipe'],windowsHide:true});let seq=0,buffer='';const pending=new Map();
child.stdout.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i).trim();buffer=buffer.slice(i+1);if(!line)continue;const msg=JSON.parse(line);pending.get(msg.id)?.(msg);pending.delete(msg.id);}});
const request=(method,params)=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error('MCP timeout'));},10000);pending.set(id,msg=>{clearTimeout(timer);if(msg.error)reject(new Error(JSON.stringify(msg.error)));else resolve(msg.result);});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
try{await request('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'member-call-role-test',version:'1'}});const r=await request('tools/call',{name:'refs',arguments:{name:'MemberCallRoles.Provider.Collision'}});assert.ok(!r.isError);assert.ok(r.content.some(c=>c.text?.includes('Owners.cs:3')),JSON.stringify(r));}finally{child.kill();}
console.log('C# member calls: static/generic/conditional callees rejected as non-delegate types; receivers, nested/new/typeof types, delegates, MCP sites and cold/warm preserved.');
