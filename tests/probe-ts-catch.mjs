import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Parser, Language } from 'web-tree-sitter';
import { LANGUAGES, resolveWasm } from '../src/languages.mjs';

await Parser.init();
for (const lang of ['typescript', 'tsx', 'vue']) {
  const profile = LANGUAGES[lang], parser = new Parser();
  parser.setLanguage(await Language.load(resolveWasm(profile)));
  test(`${lang}: simple catch values stay separate from types and nested scopes`, () => {
    const tree = parser.parse(`try {} catch (Signal) {
  Signal();
  let v: Signal;
  { const Signal = Local; Signal(); }
  const fn = () => Signal();
}
Signal();
try {} catch { Signal(); }
try {} catch ({ Signal }) { Signal(); }
`);
    try {
      assert.equal(tree.rootNode.hasError, false);
      const values = [];
      const visit = node => {
        if (['identifier', 'type_identifier'].includes(node.type) && node.text === 'Signal')
          values.push([node.startPosition.row + 1, node.type, profile.refFilter(node)]);
        for (const child of node.namedChildren) visit(child);
      };
      visit(tree.rootNode);
      assert.deepEqual(values, [
        [1,'identifier',false], [2,'identifier',false], [3,'type_identifier',true],
        [4,'identifier',true], [4,'identifier',true], [5,'identifier',true],
        [7,'identifier',true], [8,'identifier',true], [9,'identifier',true],
      ]);
    } finally { tree.delete(); }
    const nestedClass = parser.parse('try {} catch (Signal) { const C = class Signal { value = new Signal(); }; }');
    try {
      assert.equal(nestedClass.rootNode.hasError, false);
      const references = [];
      const visit = node => {
        if (node.type === 'new_expression') references.push(profile.refFilter(node.childForFieldName('constructor')));
        for (const child of node.namedChildren) visit(child);
      };
      visit(nestedClass.rootNode);
      assert.deepEqual(references, [true], 'class expression may bind its own Signal');
    } finally { nestedClass.delete(); }
  });
}
