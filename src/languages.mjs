/**
 * 语言配置表 —— 引擎通用，语言在这里描述。
 *
 * 每加一门语言只需要在这里加一份 profile：
 *   exts        文件后缀
 *   wasm        tree-sitter 语法（来自 tree-sitter-wasms）
 *   namespaces  命名空间/包 节点类型
 *   types       类型声明节点类型 -> 类别名
 *   members     成员声明节点类型 -> 类别名
 *   imports     导入语句节点类型
 *   baseFields  继承信息所在字段名
 *   baseNodes   继承信息所在子节点类型
 *   decisions   复杂度估算要数的分支节点
 *   decisionOps 只有这些运算符的 binary_expression 才算分支
 *
 * status: 'ok' 已实测过 / 'wip' 配置写好但未验证
 * 注意：每种语言的语法节点名要以实际语法为准（tests/fixtures 会跑回归）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WASM_DIR = path.join(HERE, '..', 'node_modules', 'tree-sitter-wasms', 'out');

/** const foo = () => {} / const bar = function () {} —— 是不是"函数赋值" */
function isFunctionAssignment(node) {
  const decl = node.namedChildren.find((c) => c.type === 'variable_declarator');
  if (!decl) return false;
  const value = decl.childForFieldName('value');
  return Boolean(value && ['arrow_function', 'function_expression', 'function'].includes(value.type));
}

// TS 与 TSX 的语法节点名完全一致（tsx 只是多了 JSX），共用一份
const TS_SHAPE = {
  namespaces: { internal_module: 1 },
  types: {
    class_declaration: 'class',
    abstract_class_declaration: 'class',
    interface_declaration: 'interface',
    enum_declaration: 'enum',
    type_alias_declaration: 'type',
    function_declaration: 'function',
    // export const foo = () => {} —— 箭头函数也算"函数"（只在值确实是函数时才算，见 typeGuards）
    lexical_declaration: 'function',
    variable_declaration: 'function',
  },
  typeGuards: {
    lexical_declaration: (node) => isFunctionAssignment(node),
    variable_declaration: (node) => isFunctionAssignment(node),
  },
  skipNameNodes: { required_parameter: 'pattern', optional_parameter: 'pattern', assignment_pattern: 'left', formal_parameters: 'identifier' },
  members: {
    method_definition: 'method',
    method_signature: 'method',
    abstract_method_signature: 'method',
    public_field_definition: 'field',
    property_signature: 'property',
    enum_assignment: 'enumValue',
  },
  imports: { import_statement: 1 },
  baseFields: [],
  baseNodes: ['extends_clause', 'implements_clause'],
  decisions: [
    'if_statement', 'switch_case', 'for_statement', 'for_in_statement',
    'while_statement', 'do_statement', 'catch_clause', 'ternary_expression',
    'binary_expression',
  ],
  decisionOps: ['&&', '||', '??'],
};

export const LANGUAGES = {
  csharp: {
    id: 'csharp',
    label: 'C#',
    status: 'ok',
    exts: ['.cs'],
    wasm: 'tree-sitter-c_sharp.wasm',
    preprocess: 'csharp',
    // 参数名的标识符不算"引用"（否则参数名与类型重名时会产生假依赖）
    skipNameNodes: { parameter: 'name' },
    namespaces: { namespace_declaration: 1, file_scoped_namespace_declaration: 1 },
    types: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      struct_declaration: 'struct',
      record_declaration: 'record',
      record_struct_declaration: 'record',
      enum_declaration: 'enum',
      delegate_declaration: 'delegate',
    },
    members: {
      method_declaration: 'method',
      constructor_declaration: 'ctor',
      destructor_declaration: 'dtor',
      property_declaration: 'property',
      field_declaration: 'field',
      event_declaration: 'event',
      indexer_declaration: 'indexer',
      operator_declaration: 'operator',
      enum_member_declaration: 'enumValue',
    },
    imports: { using_directive: 1 },
    baseFields: ['bases'],
    baseNodes: [],
    decisions: [
      'if_statement', 'switch_statement', 'for_statement', 'foreach_statement',
      'while_statement', 'do_statement', 'catch_clause', 'conditional_expression',
      'switch_expression', 'case_switch_label', 'binary_expression',
    ],
    decisionOps: ['&&', '||', '??'],
  },

  typescript: { id: 'typescript', label: 'TypeScript', status: 'ok', exts: ['.ts', '.mts', '.cts'], wasm: 'tree-sitter-typescript.wasm', ...TS_SHAPE },
  // .tsx 必须用 tsx 语法：typescript 语法不认 JSX
  tsx: { id: 'tsx', label: 'TSX', status: 'ok', exts: ['.tsx'], wasm: 'tree-sitter-tsx.wasm', ...TS_SHAPE },

  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    status: 'ok',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    wasm: 'tree-sitter-javascript.wasm',
    namespaces: {},
    types: {
      class_declaration: 'class',
      function_declaration: 'function',
      // export const foo = () => {} —— 箭头函数也算"函数"
      lexical_declaration: 'function',
      variable_declaration: 'function',
    },
    typeGuards: {
      lexical_declaration: (node) => isFunctionAssignment(node),
      variable_declaration: (node) => isFunctionAssignment(node),
    },
    skipNameNodes: { required_parameter: 'pattern', optional_parameter: 'pattern', assignment_pattern: 'left', formal_parameters: 'identifier' },
    members: {
      method_definition: 'method',
      field_definition: 'field',
    },
    imports: { import_statement: 1 },
    baseFields: [],
    baseNodes: ['class_heritage'],
    decisions: [
      'if_statement', 'switch_case', 'for_statement', 'for_in_statement',
      'while_statement', 'do_statement', 'catch_clause', 'ternary_expression',
      'binary_expression',
    ],
    decisionOps: ['&&', '||', '??'],
  },

  java: {
    id: 'java',
    label: 'Java',
    status: 'ok',
    exts: ['.java'],
    wasm: 'tree-sitter-java.wasm',
    namespaces: { package_declaration: 1 },
    namespaceScope: 'file',
    types: {
      class_declaration: 'class',
      interface_declaration: 'interface',
      enum_declaration: 'enum',
      record_declaration: 'record',
      annotation_type_declaration: 'annotation',
    },
    members: {
      method_declaration: 'method',
      constructor_declaration: 'ctor',
      field_declaration: 'field',
      enum_constant: 'enumValue',
    },
    imports: { import_declaration: 1 },
    baseFields: ['superclass', 'interfaces'],
    baseNodes: [],
    skipNameNodes: { formal_parameter: 'name', spread_parameter: 'name' },
    decisions: [
      'if_statement', 'switch_expression', 'switch_label', 'for_statement',
      'enhanced_for_statement', 'while_statement', 'do_statement', 'catch_clause',
      'ternary_expression', 'binary_expression',
    ],
    decisionOps: ['&&', '||'],
  },

  python: {
    id: 'python',
    label: 'Python',
    status: 'ok',
    exts: ['.py'],
    wasm: 'tree-sitter-python.wasm',
    docstring: true,
    namespaces: {},
    types: { class_definition: 'class' },
    members: {
      function_definition: 'function',
      assignment: 'field',
    },
    imports: { import_statement: 1, import_from_statement: 1 },
    baseFields: ['superclasses'],
    baseNodes: [],
    skipNameNodes: { typed_parameter: 'name', default_parameter: 'name', parameters: 'identifier' },
    decisions: [
      'if_statement', 'elif_clause', 'for_statement', 'while_statement',
      'except_clause', 'conditional_expression', 'boolean_operator',
    ],
    decisionOps: [],
  },

  kotlin: {
    id: 'kotlin',
    label: 'Kotlin',
    status: 'ok',
    exts: ['.kt', '.kts'],
    wasm: 'tree-sitter-kotlin.wasm',
    namespaces: { package_header: 1 },
    namespaceScope: 'file',
    types: {
      class_declaration: 'class',
      object_declaration: 'object',
    },
    members: {
      function_declaration: 'function',
      property_declaration: 'property',
      constructor_declaration: 'ctor',
      enum_entry: 'enumValue',
    },
    imports: { import_header: 1 },
    baseFields: [],
    baseNodes: ['delegation_specifier'],
    decisions: ['if_expression', 'when_expression', 'for_statement', 'while_statement', 'try_expression', 'catch_block'],
    decisionOps: [],
  },

  lua: {    id: 'lua',
    label: 'Lua',
    status: 'ok',
    exts: ['.lua'],
    wasm: 'tree-sitter-lua.wasm',
    namespaces: {},
    // Lua 没有类型系统，落到"函数"一级（文件会合成一个模块节点）
    types: {},
    members: {
      function_definition_statement: 'function',
      function_definition: 'function',
      local_function: 'function',
      variable_declaration: 'field',
      local_variable_declaration: 'field',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'elseif_statement', 'for_statement', 'while_statement', 'repeat_statement'],
    decisionOps: [],
  },

  bash: {
    id: 'bash',
    label: 'Shell',
    status: 'ok',
    exts: ['.sh', '.bash', '.zsh'],
    wasm: 'tree-sitter-bash.wasm',
    namespaces: {},
    types: {},
    members: {
      function_definition: 'function',
      variable_assignment: 'var',
      declaration_command: 'var',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'case_statement', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  zig: {
    id: 'zig',
    label: 'Zig',
    status: 'ok',
    exts: ['.zig'],
    wasm: 'tree-sitter-zig.wasm',
    namespaces: {},
    // Zig 的类型写在 const X = struct/enum {...}，名称在父节点上（扫描器已支持）
    types: {
      struct_declaration: 'struct',
      enum_declaration: 'enum',
      union_declaration: 'union',
    },
    members: {
      function_declaration: 'function',
      container_field: 'field',
      variable_declaration: 'const',
      test_declaration: 'function',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'while_statement', 'for_statement', 'switch_expression', 'binary_expression'],
    decisionOps: ['and', 'or'],
  },

  solidity: {
    id: 'solidity',
    label: 'Solidity',
    status: 'ok',
    exts: ['.sol'],
    wasm: 'tree-sitter-solidity.wasm',
    namespaces: {},
    types: {
      contract_declaration: 'contract',
      interface_declaration: 'interface',
      library_declaration: 'library',
    },
    members: {
      function_definition: 'function',
      constructor_definition: 'ctor',
      modifier_definition: 'modifier',
      state_variable_declaration: 'field',
      event_definition: 'event',
      struct_declaration: 'struct',
      enum_declaration: 'enum',
    },
    imports: { import_directive: 1 },
    baseFields: [],
    baseNodes: ['inheritance_specifier'],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_while_statement', 'ternary_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  ocaml: {
    id: 'ocaml',
    label: 'OCaml',
    status: 'ok',
    exts: ['.ml', '.mli'],
    wasm: 'tree-sitter-ocaml.wasm',
    namespaces: {},
    types: {
      type_definition: 'type',
      module_definition: 'module',
      exception_definition: 'exception',
    },
    members: {
      value_definition: 'value',
      constructor_declaration: 'enumValue',
      field_declaration: 'field',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_expression', 'match_expression', 'match_case', 'for_expression', 'while_expression', 'infix_expression'],
    decisionOps: ['&&', '||'],
  },

  // 下面四门的节点名都是从 tests/probe-nodes.mjs 实测出来的（不猜）
  rescript: {
    id: 'rescript',
    label: 'ReScript',
    status: 'ok',
    exts: ['.res'],
    wasm: 'tree-sitter-rescript.wasm',
    namespaces: {},
    types: {
      module_declaration: 'module',
      type_declaration: 'type',
    },
    members: {
      let_declaration: 'value',
      variant_declaration: 'enumValue',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: ['if_expression', 'switch_expression', 'switch_match', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  tlaplus: {
    id: 'tlaplus',
    label: 'TLA+',
    status: 'ok',
    exts: ['.tla'],
    wasm: 'tree-sitter-tlaplus.wasm',
    namespaces: {},
    types: {
      module: 'module',
    },
    members: {
      operator_definition: 'operator',
      variable_declaration: 'variable',
      constant_declaration: 'constant',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: ['/\\', '\\/'],
  },

  systemrdl: {
    id: 'systemrdl',
    label: 'SystemRDL',
    status: 'ok',
    exts: ['.rdl'],
    wasm: 'tree-sitter-systemrdl.wasm',
    namespaces: {},
    types: {
      component_named_def: 'component',
      component_anon_def: 'component',
    },
    members: {
      component_inst: 'instance',
      property_assignment: 'property',
      explicit_prop_assignment: 'property',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  // Emacs Lisp：没有“类型”这回事，顶层全是函数/变量 → 都挂到扫描器合成的 module 节点上
  elisp: {
    id: 'elisp',
    label: 'Emacs Lisp',
    status: 'ok',
    exts: ['.el'],
    wasm: 'tree-sitter-elisp.wasm',
    namespaces: {},
    types: {},
    members: {
      function_definition: 'function',
      special_form: 'value',
    },
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  // 说明：C / C++ / Go / Rust / Scala 的顶层函数走"文件作用域成员"，会归到
  //       扫描器自动合成的 module 节点上（这些语言本来就是以文件为单位组织的）。
  // ===========================================================================

  go: {
    id: 'go',
    label: 'Go',
    status: 'ok',
    exts: ['.go'],
    wasm: 'tree-sitter-go.wasm',
    namespaces: { package_clause: 1 },
    namespaceScope: 'file',
    types: { type_declaration: 'type' },
    // type_declaration 下面包着 type_spec，kind 要看 type_spec 的 type 字段
    typeKindFn: (node) => {
      const spec = node.namedChildren.find((c) => c.type === 'type_spec');
      const t = spec && spec.childForFieldName('type');
      if (t && t.type === 'struct_type') return 'struct';
      if (t && t.type === 'interface_type') return 'interface';
      return 'type';
    },
    members: {
      method_declaration: 'method',
      function_declaration: 'function',
      field_declaration: 'field',
      const_declaration: 'const',
      var_declaration: 'var',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'case_clause', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  rust: {
    id: 'rust',
    label: 'Rust',
    status: 'ok',
    exts: ['.rs'],
    wasm: 'tree-sitter-rust.wasm',
    namespaces: {},
    types: { struct_item: 'struct', enum_item: 'enum', trait_item: 'trait', impl_item: 'impl', union_item: 'union', type_item: 'type' },
    members: {
      function_item: 'function',
      function_signature_item: 'function',
      field_declaration: 'field',
      enum_variant: 'enumValue',
      const_item: 'const',
      static_item: 'static',
    },
    imports: { use_declaration: 1 },
    baseFields: [],
    baseNodes: [],
    // impl_item 的名字取它实现的类型（field 'type'），这样方法就挂在同名节点下
    nameFromField: { impl_item: 'type' },
    decisions: ['if_expression', 'match_expression', 'match_arm', 'for_expression', 'while_expression', 'loop_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  c: {
    id: 'c',
    label: 'C',
    status: 'ok',
    exts: ['.c', '.h'],
    wasm: 'tree-sitter-c.wasm',
    namespaces: {},
    types: { type_definition: 'type', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    // typedef struct X {...} X; 会让 struct_specifier 成为 type_definition 的子节点，别重复记
    typeSkipParent: { struct_specifier: ['type_definition'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', declaration: 'field', field_declaration: 'field', enumerator: 'enumValue' },
    imports: { preproc_include: 1 },
    baseFields: [],
    baseNodes: [],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'case_statement', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  cpp: {
    id: 'cpp',
    label: 'C++',
    status: 'ok',
    exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx'],
    wasm: 'tree-sitter-cpp.wasm',
    namespaces: { namespace_definition: 1 },
    types: { class_specifier: 'class', struct_specifier: 'struct', enum_specifier: 'enum', union_specifier: 'union' },
    typeSkipParent: { struct_specifier: ['type_definition', 'class_specifier'], enum_specifier: ['type_definition'], union_specifier: ['type_definition'] },
    members: { function_definition: 'function', field_declaration: 'field', declaration: 'field', enumerator: 'enumValue' },
    imports: { preproc_include: 1 },
    baseFields: [],
    baseNodes: ['base_class_clause'],
    decisions: ['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement', 'case_statement', 'catch_clause', 'conditional_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  php: {
    id: 'php',
    label: 'PHP',
    status: 'ok',
    exts: ['.php'],
    wasm: 'tree-sitter-php.wasm',
    namespaces: { namespace_definition: 1 },
    namespaceScope: 'file',
    types: { class_declaration: 'class', interface_declaration: 'interface', trait_declaration: 'trait', enum_declaration: 'enum' },
    members: {
      method_declaration: 'method',
      function_definition: 'function',
      property_declaration: 'property',
      const_declaration: 'const',
      enum_case: 'enumValue',
    },
    imports: { namespace_use_declaration: 1 },
    baseFields: [],
    baseNodes: ['base_clause', 'class_interface_clause'],
    decisions: ['if_statement', 'for_statement', 'foreach_statement', 'while_statement', 'switch_statement', 'case_statement', 'match_expression', 'catch_clause', 'conditional_expression', 'binary_expression'],
    decisionOps: ['&&', '||', 'and', 'or', '??'],
  },

  swift: {
    id: 'swift',
    label: 'Swift',
    status: 'ok',
    exts: ['.swift'],
    wasm: 'tree-sitter-swift.wasm',
    namespaces: {},
    types: {
      class_declaration: 'class',
      protocol_declaration: 'protocol',
      extension_declaration: 'extension',
      actor_declaration: 'class',
    },
    // Swift 语法把 class / struct / enum / protocol / extension 都归成 class_declaration，
    // 靠第一个子 token 的关键字区分
    typeKindFn: (node) => {
      const kw = node.child(0) && node.child(0).text;
      if (kw === 'struct') return 'struct';
      if (kw === 'enum') return 'enum';
      if (kw === 'protocol') return 'protocol';
      if (kw === 'extension') return 'extension';
      return 'class';
    },
    members: {
      function_declaration: 'function',
      property_declaration: 'property',
      init_declaration: 'ctor',
      enum_entry: 'enumValue',
      typealias_declaration: 'type',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: ['inheritance_specifier', 'inheritance_clause', 'type_inheritance_clause'],
    decisions: ['if_statement', 'guard_statement', 'for_statement', 'while_statement', 'repeat_while_statement', 'switch_statement', 'case_statement', 'catch_block', 'ternary_expression', 'conjunction_expression', 'disjunction_expression'],
    decisionOps: [],
  },

  scala: {
    id: 'scala',
    label: 'Scala',
    status: 'ok',
    exts: ['.scala', '.sc'],
    wasm: 'tree-sitter-scala.wasm',
    namespaces: { package_clause: 1 },
    namespaceScope: 'file',
    types: { class_definition: 'class', object_definition: 'object', trait_definition: 'trait', enum_definition: 'enum' },
    members: {
      function_definition: 'function',
      val_definition: 'field',
      var_definition: 'field',
    },
    imports: { import_declaration: 1 },
    baseFields: [],
    baseNodes: ['extends_clause'],
    decisions: ['if_expression', 'match_expression', 'case_clause', 'for_expression', 'while_expression', 'try_expression', 'binary_expression'],
    decisionOps: ['&&', '||'],
  },

  // （旧的 zig / bash 占位配置已删：节点名是猜的，且重复键会覆盖前面的真配置）

  // -------- 文件级格式：默不开，--lang json,yaml 或 --lang auto,json 才扫 --------
  json: {
    id: 'json',
    label: 'JSON',
    status: 'ok',
    optIn: true,
    exts: ['.json', '.jsonc'],
    wasm: 'tree-sitter-json.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  yaml: {
    id: 'yaml',
    label: 'YAML',
    status: 'ok',
    optIn: true,
    exts: ['.yaml', '.yml'],
    wasm: 'tree-sitter-yaml.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  toml: {
    id: 'toml',
    label: 'TOML',
    status: 'ok',
    optIn: true,
    exts: ['.toml'],
    wasm: 'tree-sitter-toml.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  css: {
    id: 'css',
    label: 'CSS',
    status: 'ok',
    optIn: true,
    exts: ['.css'],
    wasm: 'tree-sitter-css.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },

  html: {
    id: 'html',
    label: 'HTML',
    status: 'ok',
    optIn: true,
    exts: ['.html', '.htm'],
    wasm: 'tree-sitter-html.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    decisions: [],
    decisionOps: [],
  },
};

/** 后缀 -> 语言 profile */
export function languageForExt(ext) {
  for (const lang of Object.values(LANGUAGES)) {
    if (lang.exts.includes(ext)) return lang;
  }
  return null;
}

/** 命令里 --lang 的值解析：auto / 逗号列表 / 全部 */
export function resolveLanguages(spec) {
  const all = Object.values(LANGUAGES);
  // 文件级格式（json/yaml/toml/css/html）默认不开：它们没有"类型"可言，一堆配置文件会把代码地图淹了。
  // 要扫就显式指定：--lang json,yaml   或者  --lang auto,json（auto = 所有代码语言）
  const defaultSet = all.filter((l) => !l.optIn);
  if (!spec || spec === 'auto') return defaultSet;
  if (spec === 'all') return all;
  const wanted = String(spec).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const picked = [];
  for (const id of wanted) {
    if (id === 'auto') { for (const l of defaultSet) if (!picked.includes(l)) picked.push(l); continue; }
    const hit = all.find((l) => l.id === id || l.exts.includes(id) || l.label.toLowerCase() === id);
    if (!hit) throw new Error(`未知语言：${id}（可用：${all.map((l) => l.id).join(', ')}）`);
    if (!picked.includes(hit)) picked.push(hit);
  }
  return picked;
}
