import fs from'node:fs';import path from'node:path';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});
for(const[lang,dir]of[['java','java-member-declarations'],['rust','rust-member-declarations'],['php','php-member-declarations']]){
 const out=fs.mkdtempSync(path.join(root,`tests/.out/member-${lang}-`));
 const scan=warm=>{const r=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures',dir),'--lang',lang,'--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));};
 const a=scan(false),b=scan(true);assert.equal(a.totals.parseErrors,0);for(const key of['files','types','edges'])assert.ok(JSON.stringify(a[key])===JSON.stringify(b[key]),`${lang} cold/warm ${key}`);
 const type=fqn=>{const t=a.types.find(t=>t.fqn===fqn);assert.ok(t,`${lang} missing ${fqn}`);return t;};
 const edge=(from,to)=>a.edges.find(e=>e.from===type(from).id&&e.to===type(to).id);
 if(lang==='java'){
  assert.ok(!edge('memberroles.Declaration','memberroles.Coincidence'));assert.equal(edge('memberroles.Mixed','memberroles.Coincidence')?.w,2);assert.equal(edge('memberroles.Genuine','memberroles.Kept')?.w,2);
  assert.ok(type('memberroles.Declaration').memberList.some(m=>m.n==='Coincidence'));assert.ok(!type('memberroles.Declaration').uses?.some(u=>u.n==='Coincidence'));
 }else if(lang==='rust'){
  assert.ok(!edge('src/declaration.rs','Coincidence'));assert.ok(!edge('SignatureDeclaration','Coincidence'));assert.equal(edge('src/mixed.rs','Coincidence')?.w,2);assert.equal(edge('src/mixed.rs','Kept')?.w,2);assert.equal(edge('SignatureDeclaration','Kept')?.w,1);
  assert.ok(type('SignatureDeclaration').memberList.some(m=>m.n==='Coincidence'));assert.ok(!a.files.find(f=>f.path==='src/declaration.rs').uses?.some(u=>u.n==='Coincidence'));
 }else{
  for(const from of['MemberRoles.Declaration','MemberRoles.Choice','owners.php'])assert.ok(!edge(from,'MemberRoles.Coincidence'));
  assert.equal(edge('MemberRoles.Combined','MemberRoles.Coincidence')?.w,2);assert.equal(edge('MemberRoles.Genuine','MemberRoles.Kept')?.w,2);assert.equal(edge('MemberRoles.WithValue','MemberRoles.Kept')?.w,1);
  assert.ok(type('owners.php').memberList.some(m=>m.n==='Coincidence'));assert.ok(!type('MemberRoles.Declaration').uses?.some(u=>u.n==='Coincidence'));
 }
 console.log(`${lang}: declaration false edges/positions absent, members/types/body refs preserved, cold/warm equal.`);
}
