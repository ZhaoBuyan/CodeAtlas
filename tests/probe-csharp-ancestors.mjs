import assert from'node:assert/strict';import fs from'node:fs';import path from'node:path';import{spawnSync}from'node:child_process';import{fileURLToPath}from'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');fs.mkdirSync(path.join(root,'tests/.out'),{recursive:true});const out=fs.mkdtempSync(path.join(root,'tests/.out/csharp-ancestors-'));
function scan(warm=false){const r=spawnSync(process.execPath,[path.join(root,'src/cli.mjs'),'scan',path.join(root,'tests/fixtures/csharp-private-ancestors'),'--lang','csharp','--out',out,...(warm?['--incremental']:[])],{encoding:'utf8',windowsHide:true,timeout:120000});assert.equal(r.status,0,r.stdout+r.stderr);return JSON.parse(fs.readFileSync(path.join(out,'bundle.json')));}
const cold=scan(),warm=scan(true);for(const key of['files','types','edges'])assert.ok(JSON.stringify(cold[key])===JSON.stringify(warm[key]),`cold/warm ${key}`);
const edges=(from,to)=>cold.edges.filter(e=>cold.types[e.from].fqn===from&&cold.types[e.to].fqn===to);
assert.equal(edges('AncestorAccess.Outside','AncestorAccess.Math').length,0);
assert.equal(edges('AncestorAccess.MissingBinding','AncestorAccess.Coincidence').length,0);
assert.equal(edges('AncestorAccess.Vault','AncestorAccess.Math').length,2,'both partial parts keep valid access');
assert.equal(edges('AncestorAccess.Vault','AncestorAccess.Leaf').length,1,'deep public descendant remains visible within private owner');
assert.equal(edges('AncestorAccess.Sibling','AncestorAccess.Math').length,1);
assert.equal(edges('AncestorAccess.AnotherVault','AncestorAccess.Coincidence').length,1);
assert.equal(edges('AncestorAccess.Outside','AncestorAccess.Visible').length,1);
assert.ok(cold.stats.unresolved.details.entries.some(e=>e.reason==='csharp-private-container'&&e.name==='Math'));
assert.ok(cold.types.every(t=>!Object.hasOwn(t,'privateNested')));
console.log('C# private ancestors: outside veto, nested/partial positives, diagnostics and cold/warm passed.');
