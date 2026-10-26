import assert from 'node:assert/strict';import {test} from 'node:test';
import {Parser,Language} from 'web-tree-sitter';import {LANGUAGES,resolveWasm} from '../src/languages.mjs';
await Parser.init();const profile=LANGUAGES.go,parser=new Parser();parser.setLanguage(await Language.load(resolveWasm(profile)));
const parse=(source,run)=>{const tree=parser.parse(source+'\n');try{assert.equal(tree.rootNode.hasError,false);return run(tree.rootNode);}finally{tree.delete();}};
const descendants=(root,type)=>{const out=[];const visit=n=>{if(n.type===type)out.push(n);for(const c of n.namedChildren)visit(c);};visit(root);return out;};
test('Go import paths retain aliases, dot/blank imports and raw literals',()=>{
 parse('package use\nimport ("example/default"; alias `example/raw`; . "example/dot"; _ "example/side")',root=>
  assert.deepEqual(profile.packageImportsOf(root),[{path:'example/default',alias:null},{path:'example/raw',alias:'alias'},{path:'example/dot',alias:'.'},{path:'example/side',alias:'_'}]));
});
test('Go qualified types use AST components across whitespace/comments',()=>{
 parse('package use\ntype Used struct {\n A actual /* package note */ . Coincidence\n B other . Kept\n}',root=>{
  const refs=descendants(root,'qualified_type').map(n=>profile.qualifiedReferenceOf(n.childForFieldName('name')));
  assert.deepEqual(refs,['actual.Coincidence','other.Kept']);
 });
});
test('Go const declarations exclude names but preserve type references and local scope',()=>{
 parse('package use\nconst (\n One, Two = 1, 2\n Value IntType = 1\n)\nfunc A(){\n const LocalType = 1\n}\nfunc B(){\nvar v LocalType\n _ = v\n}',root=>{
  const constants=descendants(root,'const_spec');
  assert.deepEqual(profile.packageConstantsOf(root),['One','Two','Value']);
  for(const node of constants)for(const name of node.childrenForFieldName('name'))assert.equal(profile.refFilter(name),false);
  for(const node of descendants(root,'type_identifier'))assert.equal(profile.refFilter(node),true);
 });
});
