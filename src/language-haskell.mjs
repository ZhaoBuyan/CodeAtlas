/** Haskell nominal types. No value-call, constructor-to-type or build-system guesses. */
const TYPE_KINDS = { data_type: 'type', newtype: 'type', type_synomym: 'type', class: 'interface' };
const UNSUPPORTED_TYPES = new Set(['type_family', 'data_family']);
// Haskell 2010 Prelude nominal exports, plus the GHC/base Prelude additions.
// https://www.haskell.org/onlinereport/haskell2010/haskellch9.html
// https://github.com/ghc/ghc/blob/master/libraries/base/src/Prelude.hs
// These are external candidates, not graph nodes. Never attach a Prelude name
// to an unrelated local declaration merely because the library was not scanned.
const PRELUDE_TYPES = new Set(('Bool Maybe Either Ordering Char String Int Integer Float Double Rational IO '
  + 'Eq Ord Enum Bounded Num Real Integral Fractional Floating RealFrac RealFloat Monad Functor '
  + 'Read Show ReadS ShowS FilePath IOError Word Applicative MonadFail Foldable Traversable Semigroup Monoid').split(' '));
const child = (node, type) => node.namedChildren.find(n => n.type === type);
const cleanModule = node => node?.text.replace(/\s/g, '').replace(/\.$/, '') || null;
const typeNames = list => list ? list.namedChildren.flatMap(n => {
  const type = n.childForFieldName('type');
  return type && ['name', 'qualified'].includes(type.type) ? [type.text.replace(/\s/g, '')] : [];
}) : null;

export function haskellScope(root) {
  const header = child(root, 'header'), exports = header && child(header, 'exports');
  const unsupportedTypes = new Set();
  const collect = node => {
    if (UNSUPPORTED_TYPES.has(node.type) && inCode(node)) {
      const name = node.childForFieldName('name');
      if (name) unsupportedTypes.add(name.text);
    }
    for (const c of node.namedChildren) collect(c);
  };
  collect(root);
  const imports = (child(root, 'imports')?.namedChildren || []).filter(n => n.type === 'import').map(n => {
    const mods = n.namedChildren.filter(c => c.type === 'module');
    return { module: cleanModule(mods[0]), alias: cleanModule(mods[1]) || cleanModule(mods[0]),
      qualified: n.children.some(c => c.type === 'qualified'),
      hiding: n.children.some(c => c.type === 'hiding'),
      names: typeNames(child(n, 'import_list')),
      package: n.namedChildren.some(c => /string|package/.test(c.type)) };
  });
  const module = cleanModule(header && child(header, 'module')) || 'Main';
  let implicitPrelude = true;
  for (const pragma of root.namedChildren.filter(n => n.type === 'pragma')) {
    if (!/^\{-#\s*(LANGUAGE|OPTIONS_GHC)\b/.test(pragma.text)) continue;
    for (const setting of pragma.text.matchAll(/(?:\b|-X)(NoImplicitPrelude|ImplicitPrelude|RebindableSyntax)\b/g))
      implicitPrelude = setting[1] === 'ImplicitPrelude';
  }
  if (implicitPrelude && module !== 'Prelude' && !imports.some(i => i.module === 'Prelude'))
    imports.push({ module: 'Prelude', alias: 'Prelude', qualified: false, hiding: false, names: null, package: false, implicit: true });
  return {
    module,
    // No compiler flags or CPP execution: an unselected branch is not evidence.
    preprocessing: /^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif|include|define|undef)\b/m.test(root.text),
    malformed: root.hasError,
    unsupportedTypes: [...unsupportedTypes],
    // No header means `module Main (main) where`, not an export-all module.
    exports: header ? typeNames(exports) : [],
    reexports: exports ? exports.namedChildren.filter(n => n.type === 'module_export')
      .map(n => cleanModule(child(n, 'module'))).filter(Boolean) : [],
    imports,
  };
}

const excludedSyntax = new Set(['quote', 'quoted_decls', 'th_quoted_name', 'splice', 'quasiquote', 'ERROR']);
function inCode(node) {
  for (let p = node; p; p = p.parent) if (excludedSyntax.has(p.type)) return false;
  return true;
}
function isTypeReference(node) {
  if (node.type !== 'name') return false;
  // A nominal declaration name is not a reference. Data constructor names use another node type.
  if ((Object.hasOwn(TYPE_KINDS, node.parent?.type) || UNSUPPORTED_TYPES.has(node.parent?.type))
    && node.parent.childForFieldName('name')?.id === node.id) return false;
  for (let p = node.parent; p; p = p.parent) {
    if (['header', 'import'].includes(p.type)) return false;
  }
  return inCode(node);
}

/** Exact module declarations, not path suffixes; duplicate modules remain ambiguous. */
export function createHaskellResolver({ files, types }) {
  const modules = new Map(), declarations = new Map();
  for (const file of files) {
    if (file.lang !== 'haskell' || !file.symbolScope) continue;
    const key = `${file.rootId}|${file.symbolScope.module}`;
    const list = modules.get(key) || []; list.push(file); modules.set(key, list);
    const names = new Map();
    for (const id of file.types) {
      const t = types[id];
      if (t.parent != null || t.synthModule || !['type', 'interface'].includes(t.kind)) continue;
      const ids = names.get(t.name) || []; ids.push(id); names.set(t.name, ids);
    }
    declarations.set(file.id, names);
  }
  const accepts = (imp, name) => imp.names == null || (imp.hiding ? !imp.names.includes(name) : imp.names.includes(name));
  const lookup = (file, module) => modules.get(`${file.rootId}|${module}`) || [];
  const empty = () => ({ ids: new Set(), uncertain: false });
  const merge = (to, from) => {
    for (const id of from.ids) to.ids.add(id);
    to.uncertain ||= from.uncertain;
  };
  const unknown = { ids: new Set(), uncertain: true };
  const importValue = (file, imp, table, name) => {
    const targets = lookup(file, imp.module);
    if (!imp.package && !targets.length && imp.module === 'Prelude' && !PRELUDE_TYPES.has(name)) return empty();
    return !imp.package && targets.length === 1 ? table.get(targets[0].id) : unknown;
  };
  const visible = (file, name, table) => {
    const bare = empty(), qualified = new Map();
    const addQualified = (prefix, value) => {
      if (!qualified.has(prefix)) qualified.set(prefix, empty());
      merge(qualified.get(prefix), value);
    };
    const own = { ids: declarations.get(file.id)?.get(name) || [], uncertain: file.symbolScope.unsupportedTypes?.includes(name) || false };
    merge(bare, own); addQualified(file.symbolScope.module, own);
    for (const imp of file.symbolScope.imports) {
      if (!accepts(imp, name)) continue;
      const value = importValue(file, imp, table, name);
      addQualified(imp.alias, value);
      if (!imp.qualified) merge(bare, value);
    }
    return { bare, qualified };
  };
  const exportCache = new Map();
  const exportTable = name => {
    if (exportCache.has(name)) return exportCache.get(name);
    const table = new Map([...declarations.keys()].map(id => [id, empty()]));
    // Least fixed point: only add proven declarations. Cycles and diamond barrels
    // terminate without depth limits or exponential recursion; cache once per name.
    let changed;
    do {
      changed = false;
      for (const [id, output] of table) {
        const file = files[id], scope = file.symbolScope, next = empty();
        if (scope.preprocessing || scope.malformed) merge(next, unknown);
        else if (scope.exports == null) {
          for (const t of declarations.get(id)?.get(name) || []) next.ids.add(t);
          next.uncertain = scope.unsupportedTypes?.includes(name) || false;
        } else {
          const { bare, qualified } = visible(file, name, table);
          if (scope.exports.includes(name)) merge(next, bare);
          for (const [prefix, value] of qualified) {
            if (scope.exports.includes(`${prefix}.${name}`)) merge(next, value);
            if (!scope.reexports.includes(prefix)) continue;
            // `module Q` exports entities in scope both bare and as Q.T. The
            // two forms can come from different imports of the same declaration.
            for (const t of value.ids) if (bare.ids.has(t)) next.ids.add(t);
            next.uncertain ||= value.uncertain && (bare.ids.size > 0 || bare.uncertain)
              || bare.uncertain && value.ids.size > 0;
          }
        }
        const before = output.ids.size, wasUncertain = output.uncertain;
        merge(output, next);
        changed ||= output.ids.size !== before || output.uncertain !== wasUncertain;
      }
    } while (changed);
    exportCache.set(name, table);
    return table;
  };
  return (name, fromId, ref) => {
    const file = files[types[fromId]?.file], scope = file?.symbolScope;
    if (!scope) return { reason: 'haskell-no-module' };
    if (scope.preprocessing) return { reason: 'haskell-preprocessing-unresolved' };
    if (scope.malformed) return { reason: 'haskell-parse-unresolved' };
    const q = ref?.q, dot = q?.lastIndexOf('.'), prefix = q ? q.slice(0, dot) : null;
    // Local and imported declarations with the same name are ambiguous in Haskell.
    const view = visible(file, name, exportTable(name));
    const { ids, uncertain } = q ? view.qualified.get(prefix) || empty() : view.bare;
    if (ids.size === 1 && !uncertain) return { id: [...ids][0], import: true };
    return { reason: ids.size > 1 ? 'haskell-ambiguous' : 'haskell-module-unresolved', ambiguous: ids.size > 1 };
  };
}

export const HASKELL = {
  id: 'haskell', label: 'Haskell', status: 'ok', exts: ['.hs'], wasm: 'haskell/tree-sitter-haskell.wasm',
  namespaces: { header: 1 }, namespaceScope: 'file',
  namespaceNameOf: node => cleanModule(child(node, 'module')),
  types: TYPE_KINDS,
  typeGuards: Object.fromEntries(Object.keys(TYPE_KINDS).map(type => [type,
    node => node.parent?.type === 'declarations' && node.parent.parent?.type === 'haskell' && inCode(node)])),
  members: { function: 'function', bind: 'value', signature: 'signature', data_constructor: 'ctor', newtype_constructor: 'ctor', field: 'field' },
  // `function` also represents the arrow in a type signature. Only named equations are members.
  memberGuards: Object.fromEntries(['function', 'bind', 'signature', 'data_constructor', 'newtype_constructor', 'field']
    .map(type => [type, node => !!node.childForFieldName('name') && inCode(node)])),
  imports: { import: 1 }, importTextOf: node => cleanModule(child(node, 'module')) || '',
  baseFields: [], baseNodes: [], decisions: ['conditional', 'alternative'],
  refTypes: ['name'], refFilter: isTypeReference,
  qualifiedReferenceOf: node => node.parent?.type === 'qualified' ? `${cleanModule(child(node.parent, 'module'))}.${node.text}` : null,
  scopeFactsOf: haskellScope, createResolver: createHaskellResolver,
};
