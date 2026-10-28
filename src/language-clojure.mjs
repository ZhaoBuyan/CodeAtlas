/** Clojure/JVM nominal declarations and explicit type positions; never execute macros. */
const KINDS = { defrecord: 'record', deftype: 'class', defprotocol: 'interface' };
const MEMBERS = { defn: 'function', 'defn-': 'function', defmacro: 'function', def: 'value', defonce: 'value', defmulti: 'function' };
const INERT = new Set(['quoting_lit', 'syn_quoting_lit', 'var_quoting_lit', 'dis_expr', 'read_cond_lit', 'splicing_read_cond_lit', 'evaling_lit', 'tagged_or_ctor_lit']);
// Default class mappings from Clojure RT.DEFAULT_IMPORTS. Unscanned platform
// classes must not be confused with same-named project declarations.
// https://github.com/clojure/clojure/blob/master/src/jvm/clojure/lang/RT.java
const DEFAULT_CLASSES = new Set(('AbstractMethodError Appendable ArithmeticException ArrayIndexOutOfBoundsException ArrayStoreException AssertionError AutoCloseable '
  + 'BigDecimal BigInteger Boolean BootstrapMethodError Byte Callable CharSequence Character Class ClassCastException ClassCircularityError ClassFormatError ClassLoader ClassNotFoundException ClassValue CloneNotSupportedException Cloneable Comparable Compiler Deprecated Double Enum EnumConstantNotPresentException Error Exception ExceptionInInitializerError Float '
  + 'IllegalAccessError IllegalAccessException IllegalArgumentException IllegalCallerException IllegalMonitorStateException IllegalStateException IllegalThreadStateException IncompatibleClassChangeError IndexOutOfBoundsException InheritableThreadLocal InstantiationError InstantiationException Integer InternalError InterruptedException Iterable LayerInstantiationException LinkageError Long Math ModuleLayer NegativeArraySizeException NoClassDefFoundError NoSuchFieldError NoSuchFieldException NoSuchMethodError NoSuchMethodException NullPointerException Number NumberFormatException Object OutOfMemoryError Override Package Process ProcessBuilder ProcessHandle Readable ReflectiveOperationException Runnable Runtime RuntimeException RuntimePermission SecurityException SecurityManager Short StackOverflowError StackTraceElement StackWalker StrictMath String StringBuffer StringBuilder StringIndexOutOfBoundsException SuppressWarnings System Thread Thread$State Thread$UncaughtExceptionHandler ThreadDeath ThreadGroup ThreadLocal Throwable TypeNotPresentException UnknownError UnsatisfiedLinkError UnsupportedClassVersionError UnsupportedOperationException VerifyError VirtualMachineError Void ExceptionInfo '
  + 'boolean byte char short int long float double void booleans bytes chars shorts ints longs floats doubles objects').split(' '));
const ROOT_CACHE = new WeakMap();
const children = node => (node?.namedChildren || []).filter(n => n.type !== 'comment');
const sym = node => node?.type === 'sym_lit' ? [node.childForFieldName('ns')?.text || children(node).find(n => n.type === 'sym_ns')?.text,
  node.childForFieldName('name')?.text].filter(Boolean).join('/') : null;
const head = node => node?.type === 'list_lit' ? sym(children(node)[0]) : null;
const bareHead = node => head(node)?.replace(/^clojure\.core\//, '') || null;
const privateName = node => children(node).some(meta => {
  if (meta.type !== 'meta_lit') return false;
  const value = children(meta)[0];
  if (value?.text === ':private') return true;
  if (value?.type !== 'map_lit') return false;
  const pairs = children(value);
  return pairs.some((n,i) => i % 2 === 0 && n.text === ':private' && pairs[i+1] && !['nil','false'].includes(pairs[i+1].text));
});
const rootOf = node => { let root = node; while (root.parent) root = root.parent; return root; };
const isTop = node => node.parent?.type === 'source';
const core = (node, name) => head(node) === `clojure.core/${name}`
  || (head(node) === name && !clojureScope(rootOf(node)).shadowed.includes(name));
const isInert = node => {
  for (let p = node; p; p = p.parent) {
    if (INERT.has(p.type)) return true;
    if (p.type === 'list_lit' && (head(p) === 'quote' || ['comment', 'defmacro', 'ns'].some(n => core(p, n)))) return true;
  }
  return false;
};
const declaration = node => {
  const h = bareHead(node);
  if (!isTop(node) || !Object.hasOwn(KINDS, h || '') || !core(node, h) || !clojureScope(rootOf(node)).module) return null;
  const name = sym(children(node)[1]);
  return name && /^[$A-Za-z_][$\w]*$/.test(name) ? { kind: KINDS[h], name } : null;
};

/** JSON-only facts survive worker merging and the incremental cache. */
export function clojureScope(root) {
  const tree = root.tree;
  if (tree && ROOT_CACHE.has(tree)) return ROOT_CACHE.get(tree);
  const forms = children(root), nsForms = forms.filter(n => ['ns', 'clojure.core/ns'].includes(head(n)));
  const scope = { module: nsForms.length === 1 ? sym(children(nsForms[0])[1]) : null,
    imports: [], classes: [], importPaths: [], shadowed: [], boundVars: [], privateSymbols: [], unsupported: [], malformed: root.hasError };
  const warn = (kind, node) => scope.unsupported.push({ kind, line: node.startPosition.row + 1 });
  if (nsForms.length !== 1) warn(nsForms.length ? 'multiple-namespaces' : 'missing-namespace', root);
  if (nsForms.length === 1 && forms.find(n => !INERT.has(n.type))?.id !== nsForms[0].id) warn('late-namespace', nsForms[0]);
  for (const form of forms) {
    if (Object.hasOwn(MEMBERS, bareHead(form) || '')) {
      const name = sym(children(form)[1]);
      if (name) { scope.shadowed.push(name); scope.boundVars.push(name); }
    }
    if (['in-ns', 'clojure.core/in-ns'].includes(head(form))) {
      scope.module = null; warn('dynamic-namespace', form);
    }
    if (['read_cond_lit', 'splicing_read_cond_lit'].includes(form.type)) warn('reader-conditional', form);
    const name = sym(children(form)[1]);
    if (name && privateName(children(form)[1])) scope.privateSymbols.push(name);
  }
  const requireSpec = (node, prefix = '') => {
    if (node.type === 'sym_lit') {
      const module = sym(node); if (module) scope.imports.push({ module: prefix + module, alias: null, refers: [], all: false, rename: {} });
      return;
    }
    const parts = children(node), module = sym(parts[0]);
    if (!module || !['vec_lit', 'list_lit'].includes(node.type)) { warn('require-spec', node); return; }
    if (node.type === 'list_lit') { for (const child of parts.slice(1)) requireSpec(child, `${prefix}${module}.`); return; }
    const entry = { module: prefix + module, alias: null, refers: [], all: false, rename: {} };
    for (let i = 1; i < parts.length; i += 2) {
      const option = parts[i].text, value = parts[i + 1];
      if (option === ':as' && sym(value)) entry.alias = sym(value);
      else if (option === ':refer' && value?.type === 'vec_lit' && children(value).every(n => sym(n))) entry.refers = children(value).map(sym);
      else if (option === ':refer' && value?.text === ':all') entry.all = true;
      else if (option === ':rename' && value?.type === 'map_lit') {
        const names = children(value); if (names.length % 2 || names.some(n => !sym(n))) entry.unsupported = true;
        else entry.rename = Object.fromEntries(Array.from({length:names.length / 2}, (_, j) => [sym(names[j * 2]), sym(names[j * 2 + 1])]));
      } else { entry.unsupported = true; warn(option === ':as-alias' ? 'alias-without-load' : 'require-option', parts[i]); }
    }
    scope.imports.push(entry);
  };
  const importSpec = node => {
    if (node.type === 'sym_lit') {
      const fqn = sym(node); if (fqn?.includes('.') && !fqn.includes('/')) scope.classes.push({ name: fqn.split('.').pop(), fqn });
      else warn('class-import', node);
      return;
    }
    const parts = children(node), prefix = sym(parts[0]);
    if (!prefix || !['vec_lit', 'list_lit'].includes(node.type) || parts.slice(1).some(n => !sym(n))) { warn('class-import', node); return; }
    for (const p of parts.slice(1)) scope.classes.push({ name: sym(p), fqn: `${prefix}.${sym(p)}` });
  };
  if (nsForms.length === 1) for (const clause of children(nsForms[0]).slice(2)) {
    if (clause.type !== 'list_lit') continue;
    const parts = children(clause), option = parts[0]?.text;
    if (option === ':require') for (const n of parts.slice(1)) requireSpec(n);
    else if (option === ':import') for (const n of parts.slice(1)) importSpec(n);
    else if (option === ':refer-clojure') {
      for (let i = 1; i < parts.length; i += 2) {
        if (parts[i].text === ':exclude') scope.shadowed.push(...children(parts[i + 1]).map(sym).filter(Boolean));
        else if (parts[i].text === ':rename') scope.shadowed.push(...children(parts[i + 1]).filter((_, j) => j % 2 === 0).map(sym).filter(Boolean));
        else if (parts[i].text === ':only' && parts[i + 1]?.type === 'vec_lit') {
          const kept = children(parts[i + 1]).map(sym);
          scope.shadowed.push(...[...Object.keys(KINDS), ...Object.keys(MEMBERS), 'reify', 'comment'].filter(n => !kept.includes(n)));
        } else warn('refer-clojure-option', parts[i]);
      }
    } else warn('namespace-clause', clause);
  }
  for (const imp of scope.imports) scope.shadowed.push(...imp.refers.map(n => Object.hasOwn(imp.rename, n) ? imp.rename[n] : n));
  // Namespace mutations invalidate static provenance, even inside wrappers.
  const inspect = node => {
    if (['evaling_lit','tagged_or_ctor_lit','read_cond_lit','splicing_read_cond_lit'].includes(node.type)) warn('dynamic-reader', node);
    if (INERT.has(node.type)) return;
    const h = bareHead(node);
    if (['quote', 'comment', 'defmacro'].includes(h)) return;
    if (['in-ns','require','use','refer','alias','import','load','load-file','ns-unmap','ns-unalias','remove-ns','intern'].includes(h))
      warn('runtime-namespace-operation', node);
    for (const n of children(node)) inspect(n);
  };
  for (const form of forms) if (!nsForms.some(n => n.id === form.id)) inspect(form);
  scope.blocked = scope.malformed || scope.unsupported.length > 0;
  scope.importPaths = [...new Set([...scope.imports.map(i => i.module), ...scope.classes.map(i => i.fqn)])];
  scope.shadowed = [...new Set(scope.shadowed)];
  if (tree) ROOT_CACHE.set(tree, scope);
  return scope;
}

function referenceRole(node) {
  if (node.type !== 'sym_name' || node.parent?.type !== 'sym_lit' || isInert(node)) return null;
  const literal = node.parent, owner = literal.parent, parts = children(owner), index = parts.findIndex(n => n.id === literal.id);
  // JVM type hints: ^Foo or ^{:tag Foo}. Other metadata is ordinary data.
  if (owner?.type === 'meta_lit' && children(owner)[0]?.id === literal.id) return 'clojure-class';
  if (owner?.type === 'map_lit' && owner.parent?.type === 'meta_lit' && index % 2 === 1 && parts[index - 1]?.text === ':tag') return 'clojure-class';
  if (owner?.type !== 'list_lit') return null;
  const h = bareHead(owner);
  if (index === 1 && head(owner) === 'new') return 'clojure-class';
  if (index === 0 && /^[^/\s.][^/\s]*\.$/.test(sym(literal) || '')) return 'clojure-class';
  if (['defrecord', 'deftype'].includes(h) && declaration(owner)) {
    const fields = parts.findIndex(n => n.type === 'vec_lit');
    if (fields >= 2 && index > fields) return 'clojure-implementation';
  }
  return null;
}

export function createClojureResolver({ files, types }) {
  const protocols = new Map(), classes = new Map();
  const insert = (map, key, id) => { const ids = map.get(key) || []; ids.push(id); map.set(key, ids); };
  for (const t of types) {
    const file = files[t.file], scope = file?.symbolScope;
    if (file?.lang !== 'clojure' || !scope?.module || t.parent != null || t.synthModule || !['class', 'record', 'interface'].includes(t.kind)) continue;
    const root = file.rootId || '';
    insert(classes, `${root}|${scope.module.replace(/-/g, '_')}.${t.name}`, t.id);
    if (t.kind === 'interface') insert(protocols, `${root}|${scope.module}/${t.name}`, t.id);
  }
  return (name, fromId, ref) => {
    const file = files[types[fromId]?.file], scope = file?.symbolScope;
    if (!scope?.module) return { reason: 'clojure-namespace-unresolved' };
    if (scope.blocked) return { reason: scope.malformed ? 'clojure-parse-unresolved' : 'clojure-dynamic-scope' };
    const raw = ref?.q || name, root = file.rootId || '', found = new Set();
    let uncertain = false;
    const add = (map, key, external = false) => {
      const ids = map.get(`${root}|${key}`) || [];
      for (const id of ids) {
        const target = types[id], targetScope = files[target.file].symbolScope;
        if (targetScope.blocked || map === protocols && targetScope.boundVars.includes(target.name)
          || external && targetScope.privateSymbols.includes(target.name)) uncertain = true;
        else found.add(id);
      }
      if (!ids.length) uncertain = true;
    };
    const classPosition = ref?.role === 'clojure-class' || ref?.role === 'clojure-implementation' && !raw.includes('/');
    if (classPosition) {
      const className = raw.replace(/\.$/, '');
      if (className.includes('/')) return { reason: 'clojure-class-unresolved' };
      if (className.includes('.')) add(classes, className);
      else {
        const key = `${scope.module.replace(/-/g, '_')}.${className}`;
        if (DEFAULT_CLASSES.has(className)) uncertain = true;
        // defprotocol creates a Var and a JVM interface, but does not import the
        // interface as a simple Class binding. Records/types do import theirs.
        if ((classes.get(`${root}|${key}`) || []).some(id => ref.role !== 'clojure-class' || types[id].kind !== 'interface')) add(classes, key);
        if (scope.boundVars.includes(className)) uncertain = true;
        for (const item of scope.classes) if (item.name === className) add(classes, item.fqn);
      }
    }
    if (ref?.role === 'clojure-implementation' && !raw.replace(/\.$/, '').includes('.') || ref?.role === 'clojure-implementation' && raw.includes('/')) {
      const slash = raw.indexOf('/'), prefix = slash >= 0 ? raw.slice(0, slash) : null, leaf = slash >= 0 ? raw.slice(slash + 1) : raw;
      if ((!prefix || prefix === scope.module) && protocols.has(`${root}|${scope.module}/${leaf}`)) add(protocols, `${scope.module}/${leaf}`);
      if (!prefix && scope.boundVars.includes(leaf)) uncertain = true;
      for (const imp of scope.imports) {
        if (imp.unsupported) { uncertain = true; continue; }
        if (prefix) { if (prefix === imp.alias || prefix === imp.module) add(protocols, `${imp.module}/${leaf}`, true); }
        else {
          const original = Object.entries(imp.rename).find(([, renamed]) => renamed === leaf)?.[0] || leaf;
          if ((imp.all || imp.refers.includes(original)) && (!Object.hasOwn(imp.rename, original) || imp.rename[original] === leaf)) add(protocols, `${imp.module}/${original}`, true);
        }
      }
    }
    if (!classPosition && ref?.role !== 'clojure-implementation') return { reason: 'clojure-unsupported-reference-role' };
    if (found.size === 1 && !uncertain) {
      const id = [...found][0]; return { id, ...(types[id].file !== file.id ? { import: true } : {}) };
    }
    return { reason: found.size > 1 ? 'clojure-ambiguous' : 'clojure-type-unresolved', ambiguous: found.size > 1 };
  };
}

export const CLOJURE = {
  id: 'clojure', label: 'Clojure', status: 'ok', exts: ['.clj'], wasm: 'clojure/tree-sitter-clojure.wasm',
  namespaces: {}, namespaceScope: 'file', fileNamespaceOf: root => clojureScope(root).module,
  types: {}, kindOf: node => declaration(node)?.kind || null,
  nameOf: node => declaration(node)?.name || (node.type === 'list_lit' ? sym(children(node)[1]) : node.type === 'sym_lit' ? sym(node) : null),
  members: {},
  memberKindOf: node => {
    if (isInert(node)) return null;
    const h = bareHead(node);
    if (isTop(node) && Object.hasOwn(MEMBERS, h || '') && core(node, h)) return MEMBERS[h];
    if (node.type === 'list_lit' && declaration(node.parent) && children(node).some(n => n.type === 'vec_lit')) return 'method';
    if (node.type === 'sym_lit' && node.parent?.type === 'vec_lit' && declaration(node.parent.parent)
      && children(node.parent.parent).find(n => n.type === 'vec_lit')?.id === node.parent.id) return 'field';
    return null;
  },
  // Method names are first in a list; declarations put the name second.
  membersOf: node => node.type === 'list_lit' && declaration(node.parent) && children(node).some(n => n.type === 'vec_lit')
    ? [{ name: head(node), kind: 'method' }] : [],
  paramsOf: node => children(node).find(n => n.type === 'vec_lit') || null,
  imports: {}, baseFields: [], baseNodes: [], decisions: [],
  refTypes: ['sym_name'], refFilter: node => !!referenceRole(node),
  referenceRoleOf: referenceRole,
  referenceNameOf: node => node.text.replace(/\.$/, '').split('.').pop(),
  referenceUseKindOf: node => {
    if (!referenceRole(node)) return null;
    const form = node.parent?.parent;
    return form?.type === 'list_lit' && (head(form) === 'new' || children(form)[0]?.id === node.parent.id) ? 'call' : 'member';
  },
  qualifiedReferenceOf: node => node.parent?.type === 'sym_lit' ? sym(node.parent) : null,
  scopeFactsOf: clojureScope, createResolver: createClojureResolver,
};
