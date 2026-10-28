/** Elm nominal types only: imports/exports are evidence; value names are not type refs. */
const child = (node, type) => node?.namedChildren.find(n => n.type === type);
const qid = node => child(node, 'upper_case_qid')?.text.replace(/\s/g, '') || null;
const TYPES = { type_declaration: 'type', type_alias_declaration: 'type' };
const exposed = node => {
  const list = child(node, 'exposing_list');
  return {
    all: !!list?.namedChildren.some(n => n.type === 'double_dot'),
    names: (list?.namedChildren || []).filter(n => n.type === 'exposed_type')
      .map(n => child(n, 'upper_case_identifier')?.text).filter(Boolean),
  };
};
// https://github.com/elm/core#default-imports -- only the type namespace is relevant.
const DEFAULTS = [
  ['Basics', 'Basics', ['Int', 'Float', 'Bool', 'Order', 'Never']],
  ['List', 'List', ['List']], ['Maybe', 'Maybe', ['Maybe']], ['Result', 'Result', ['Result']],
  ['String', 'String', ['String']], ['Char', 'Char', ['Char']],
  ['Tuple', 'Tuple', []], ['Debug', 'Debug', []], ['Platform', 'Platform', ['Program']],
  ['Platform.Cmd', 'Cmd', ['Cmd']], ['Platform.Sub', 'Sub', ['Sub']],
];

export function elmScope(root) {
  const header = child(root, 'module_declaration');
  const module = qid(header) || 'Main';
  const imports = root.namedChildren.filter(n => n.type === 'import_clause').map(n => ({
    module: qid(n), alias: child(n, 'as_clause')?.childForFieldName('name')?.text || qid(n), ...exposed(n),
  }));
  for (const [name, alias, names] of DEFAULTS) if (name !== module)
    imports.push({ module: name, alias, names, all: false, implicit: true });
  return { module, malformed: root.hasError, exports: header ? exposed(header) : { all: true, names: [] }, imports };
}

function isTypeReference(node) {
  // The qid is the type constructor, excluding its type arguments (which have their own qids).
  return node.type === 'upper_case_qid' && node.parent?.type === 'type_ref'
    && child(node.parent, 'upper_case_qid')?.id === node.id;
}

export function createElmResolver({ files, types }) {
  const modules = new Map(), declarations = new Map();
  for (const file of files) {
    if (file.lang !== 'elm' || !file.symbolScope) continue;
    const key = `${file.rootId}|${file.symbolScope.module}`, found = modules.get(key) || [];
    found.push(file); modules.set(key, found);
    const names = new Map();
    for (const id of file.types) {
      const t = types[id];
      if (t.kind !== 'type' || t.parent != null || t.synthModule) continue;
      const ids = names.get(t.name) || []; ids.push(id); names.set(t.name, ids);
    }
    declarations.set(file.id, names);
  }
  return (name, fromId, ref) => {
    const file = files[types[fromId]?.file], scope = file?.symbolScope;
    if (!scope) return { reason: 'elm-no-module' };
    if (scope.malformed) return { reason: 'elm-parse-unresolved' };
    const prefix = ref?.q?.slice(0, ref.q.lastIndexOf('.'));
    const ids = new Set(); let uncertain = false, duplicateModule = false;
    if (!prefix) for (const id of declarations.get(file.id)?.get(name) || []) ids.add(id);
    for (const imp of scope.imports) {
      if (prefix ? prefix !== imp.alias : !(imp.all || imp.names.includes(name))) continue;
      const targets = modules.get(`${file.rootId}|${imp.module}`) || [];
      if (targets.length !== 1) {
        // Missing default modules only compete for the known default type names.
        // An arbitrary external import exposing(..) must still prevent a guess.
        if (!imp.implicit || imp.names.includes(name)) uncertain = true;
        duplicateModule ||= targets.length > 1;
        continue;
      }
      const target = targets[0], targetScope = target.symbolScope;
      if (targetScope.malformed) { uncertain = true; continue; }
      if (!(targetScope.exports.all || targetScope.exports.names.includes(name))) continue;
      for (const id of declarations.get(target.id)?.get(name) || []) ids.add(id);
    }
    if (ids.size === 1 && !uncertain && !duplicateModule) return { id: [...ids][0], import: true };
    return { reason: duplicateModule || ids.size > 1 ? 'elm-ambiguous' : 'elm-module-unresolved', ambiguous: duplicateModule || ids.size > 1 };
  };
}

export const ELM = {
  id: 'elm', label: 'Elm', status: 'ok', exts: ['.elm'], wasm: 'elm/tree-sitter-elm.wasm',
  namespaces: {}, namespaceScope: 'file', fileNamespaceOf: root => qid(child(root, 'module_declaration')) || 'Main',
  types: TYPES,
  typeGuards: Object.fromEntries(Object.keys(TYPES).map(type => [type, node => node.parent?.type === 'file'])),
  nameOf: node => node.childForFieldName('name')?.text || child(child(node, 'function_declaration_left'), 'lower_case_identifier')?.text || null,
  members: { value_declaration: 'function', type_annotation: 'signature', union_variant: 'ctor', field_type: 'field', port_annotation: 'port' },
  memberGuards: {
    value_declaration: node => node.parent?.type === 'file' && !!child(node, 'function_declaration_left'),
    type_annotation: node => node.parent?.type === 'file',
  },
  returnTypeOf: node => node.type === 'type_annotation' ? child(node, 'type_expression') : null,
  imports: { import_clause: 1 }, importTextOf: node => qid(node) || '',
  refTypes: ['upper_case_qid'], refFilter: isTypeReference,
  referenceNameOf: node => node.text.replace(/\s/g, '').split('.').pop(),
  qualifiedReferenceOf: node => node.text.includes('.') ? node.text.replace(/\s/g, '') : null,
  referenceUseKindOf: node => isTypeReference(node) ? 'member' : null,
  scopeFactsOf: elmScope, createResolver: createElmResolver,
  baseFields: [], baseNodes: [], decisions: [], decisionOps: [],
};
