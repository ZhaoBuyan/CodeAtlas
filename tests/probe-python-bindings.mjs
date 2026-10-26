import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

await Parser.init();
const profile = LANGUAGES.python;
const parser = new Parser();
parser.setLanguage(await Language.load(resolveWasm(profile)));
const loader = `def load():
    location = os.path.join(os.path.dirname(__file__), 'pkg/dynamic.py')
    spec = importlib.util.spec_from_file_location('fixture', location)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.DynRequest
`;
const bindingsOf = source => {
  const tree = parser.parse(source);
  try {
    assert.equal(tree.rootNode.hasError, false);
    const bindings = new Map();
    for (const node of tree.rootNode.namedChildren) for (const [name, module] of profile.moduleBindingsOf(node)) {
      if (!bindings.has(name)) bindings.set(name, new Set());
      bindings.get(name).add(module);
    }
    return profile.dynamicBindingsOf(tree.rootNode, bindings);
  } finally { tree.delete(); }
};
const imports = 'import importlib.util\nimport os\n';
test('literal loader retains explicit evidence', () => {
  assert.deepEqual(bindingsOf(`${imports}${loader}\nDynRequest = load()\n`), [['DynRequest', '.pkg.dynamic.DynRequest']]);
});
for (const [label, source] of [
  ['redefined helper', `${imports}${loader}\ndef load():\n    return foreign.Value\nDynRequest = load()\n`],
  ['reassigned helper', `${imports}${loader}\nload = other\nDynRequest = load()\n`],
  ['import shadows helper', `${imports}${loader}\nfrom foreign import load\nDynRequest = load()\n`],
  ['call before helper definition', `${imports}DynRequest = load()\n${loader}`],
]) test(label, () => assert.deepEqual(bindingsOf(source), []));

test('qualified bases accept legal whitespace and preserve multiple bases', () => {
  const tree = parser.parse('class Child(pkg . Request, alias . Response[int]):\n    pass\n');
  try {
    assert.equal(tree.rootNode.hasError, false);
    assert.deepEqual(profile.baseNamesOf(tree.rootNode.namedChildren[0]), ['pkg.Request', 'alias.Response']);
  } finally { tree.delete(); }
});
