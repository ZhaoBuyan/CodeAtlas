/**
 * 语言配置表 —— 引擎通用，语言在这里描述。
 *
 * 每加一门语言只需要在这里加一份 profile：
 *   exts        文件后缀
 *   wasm        tree-sitter 语法（相对 WASM_ROOTS 的路径，如 'ruby/tree-sitter-ruby.wasm'）；用 resolveWasm() 解析
 *   namespaces  命名空间/包 节点类型
 *   fileScopedNamespaces  其中"作用到文件后续全部声明"的那几种（C# 10 的 `namespace X;`）——
 *               新版 C# 语法里 file_scoped_namespace_declaration 只包住名字，
 *               后面的类型声明是它的**兄弟节点**，不能当普通块来处理
 *   types       类型声明节点类型 -> 类别名
 *   members     成员声明节点类型 -> 类别名
 *   imports     导入语句节点类型
 *   baseFields  继承信息所在字段名
 *   baseNodes   继承信息所在子节点类型
 *   decisions   复杂度估算要数的分支节点
 *   decisionOps 只有这些运算符的 binary_expression 才算分支
 *
 * 可选钩子（节点名表达不了的写法才用得上）：nameOf / kindOf / typeKindFn / memberKindOf /
 *   membersOf（一个节点→多个成员，如 Ruby 的 attr_accessor :a, :b）/ importKindOf / importTextOf /
 *   isDecision / skipNameNodes / docstring。注意：memberKindOf 一旦存在就**完全接管**成员判定，
 *   不再回退静态表（踩过这个坑）——需要两者兼得就用 membersOf 自己兜底。
 *
 * status: 'ok' 已实测过 / 'wip' 配置写好但未验证
 * 注意：每种语言的语法节点名要以实际语法为准（tests/fixtures 会跑回归）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_ROOT = path.join(HERE, '..');

/**
 * 语法包目录（按顺序找）：
 *   ① node_modules/tree-sitter-wasm/out —— 主来源（105 个语法包；布局是 <语言>/tree-sitter-<语言>.wasm）
 *   ② vendor/wasm                       —— 上游没有现成 wasm 的，自己编或从别的包取（目前：TLA+ / SystemRDL）
 * 换了运行时（web-tree-sitter 0.27）之后，旧的 tree-sitter-wasms@0.1.13（ABI 14）已不能加载，不再使用。
 */
export const WASM_ROOTS = [
  path.join(ENGINE_ROOT, 'node_modules', 'tree-sitter-wasm', 'out'),
  path.join(ENGINE_ROOT, 'vendor', 'wasm'),
];

/** profile.wasm → 绝对路径（打包脚本用同一套规则，别在两处各写一份） */
export function resolveWasm(profile, roots = WASM_ROOTS) {
  const cands = roots.map((root) => path.join(root, profile.wasm));
  return cands.find((p) => fs.existsSync(p)) || cands[0];
}

/** const foo = () => {} / const bar = function () {} —— 是不是"函数赋值" */
// ---------- Elixir 专用：defmodule / def / alias 在语法树里全是 call 节点，只能按“调用的名字”判断 ----------
function elixirCallee(node) {
  if (!node || node.type !== 'call') return null;
  const target = node.childForFieldName('target') || node.namedChildren[0];
  return target && target.type === 'identifier' ? target.text : null;
}
function elixirName(node) {
  const callee = elixirCallee(node);
  if (!callee) return null;
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  if (!first) return null;
  if (callee === 'defmodule') {
    // 取最后一段当名字（Shape.Utils → Utils）：解析器是按名字/全名匹配的，带前缀会匹配不上
    if (first.type !== 'alias') return null;
    const t = first.text;
    const dot = t.lastIndexOf('.');
    return dot >= 0 ? t.slice(dot + 1) : t;
  }
  if (callee.startsWith('def')) {
    if (first.type === 'identifier') return first.text;
    if (first.type === 'call') return elixirCallee(first);   // def area(x) → 名字在里层的 call 上
    return null;
  }
  return null;
}
const elixirKind = (node) => (elixirCallee(node) === 'defmodule' ? 'module' : null);
function elixirMemberKind(node) {
  const c = elixirCallee(node);
  if (!c) return null;
  if (['def', 'defp', 'defmacro', 'defmacrop', 'defdelegate'].includes(c)) return 'function';
  if (c === 'defstruct') return 'struct';
  if (c === 'defprotocol' || c === 'defimpl') return 'protocol';
  return null;
}
const elixirImportKind = (node) => (['alias', 'import', 'use', 'require'].includes(elixirCallee(node)) ? 'import' : null);
/** 导入名要剥掉关键字：alias Shape.Utils → Shape.Utils（否则解析器拿着 "alias Shape.Utils" 匹配不上） */
const elixirImportText = (node) => {
  const args = node.namedChildren.find((c) => c.type === 'arguments');
  const first = args && args.namedChildren[0];
  if (!first) return '';
  // 只取最后一段（Shape.Utils → Utils）：跟类型名字保持一致，解析器才匹配得上
  const t = first.text;
  const dot = t.lastIndexOf('.');
  return dot >= 0 ? t.slice(dot + 1) : t;
};
const elixirIsDecision = (node) => {
  const c = elixirCallee(node);
  if (!c || !/^[a-z]/.test(c)) return false;   // 模块属性等（@doc）不要算进来
  return ['if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive'].includes(c);
};

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

// ---------- HCL / Terraform ----------
// 实测结构（2026-09-17）：
//   block = [identifier(块类型) string_lit(标签…) block_start body block_end]
//   attribute = [identifier(属性名) expression]
// 注意 terraform 与 hcl 两个语法包对同一份 .tf 产出的树**一模一样**，选了 hcl（覆盖面更广：.tf/.tfvars/.hcl/.nomad）。
const HCL_KINDS = { resource: 'resource', data: 'data', module: 'module', variable: 'variable', output: 'output', locals: 'locals', terraform: 'terraform' };

/** 只有 block 算类型；块类型（resource / variable / locals …）作为类别 */
const hclKind = (node) => {
  if (node.type !== 'block') return null;
  const head = node.namedChildren[0];
  return (head && head.type === 'identifier' && HCL_KINDS[head.text]) || 'block';
};

/**
 * 取名：block 用**最后一个标签**，attribute 用它自己的标识符。
 *
 * 为什么不用 `aws_instance.web` 这种全地址：引用侧（`data.aws_ami.ubuntu.id` / `aws_instance.web[0]`）
 * 能拆出来的记号只有 `data` `aws_ami` `ubuntu` `id` 这种单段，名字带点就永远对不上 ——
 * 实测：用全地址时 7 个块 0 条边、29 处引用没匹配；改成最后一段后边就出来了（代价：同一份配置里
 * 如果两个块最后一个标签撞名，会算进 ambiguous 计数——那正是这个计数存在的意义）。
 */
const hclName = (node) => {
  if (node.type === 'attribute') {
    const id = node.namedChildren.find((c) => c.type === 'identifier');
    return id ? id.text : null;
  }
  if (node.type !== 'block') return null;
  const labels = node.namedChildren
    .filter((c) => c.type === 'string_lit')
    .map((s) => s.text.replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (labels.length) return labels[labels.length - 1];
  const head = node.namedChildren[0];
  return head && head.type === 'identifier' ? head.text : null;
};

// ---------- GraphQL（SDL）----------
// 实测结构（2026-09-17）：节点在 document → definition → type_system_definition 下面，
// 但走 namedChildren 遍历会自然穿透；**注意 name 是子节点不是字段**（childForFieldName('name') 拿不到），
// 所以取名必须用 nameOf 钩子；"""说明""" 是 description 节点（不是注释）→ 用 docstring 钩子。
const gqlName = (node) => {
  // enum 值的名字深一层：enum_value_definition → enum_value → name（实测，不特殊处理会一个都抽不到）
  if (node.type === 'enum_value_definition') {
    const v = node.namedChildren.find((c) => c.type === 'enum_value');
    const n = v && v.namedChildren.find((c) => c.type === 'name');
    return n ? n.text : null;
  }
  const n = node.namedChildren.find((c) => c.type === 'name');
  if (n) return n.text;
  if (node.type === 'schema_definition') return 'schema';   // 它没有名字，但它是块真正的根声明
  return null;
};

/** """这是说明""" → description 节点 → 取里面的字符串并压成一行 */
const gqlDescription = (node) => {
  const d = node.namedChildren.find((c) => c.type === 'description');
  if (!d) return null;
  return d.text.replace(/^"""|"""$/g, '').replace(/"([^"]*)"/g, '$1');
};

/**
 * 参数与字段在语法树里是同一个节点类型（input_value_definition），靠父节点分：
 *   `latest(limit: Int)` → arguments_definition 下的是**参数**；
 *   `input PostInput { title: String! }` → input_fields_definition 下的是**字段**。
 * 不分的话 Query 的成员表里会出现 limit / after / text 这些参数，看着像字段（实测踩到）。
 */
const gqlMembersOf = (node) => {
  if (node.type !== 'input_value_definition') return null;
  const kind = node.parent && node.parent.type === 'arguments_definition' ? 'argument' : 'field';
  const name = gqlName(node);
  return name ? [{ kind, name }] : null;
};

// ---------- Ruby ----------
// 节点名都是实测出来的（2026-09-17，tests/probe-nodes.mjs + 一份特意写全各种写法的样本）：
//   class / module / method / singleton_method / superclass / call / if / unless / case / while / until / for
// Ruby 的“钩子”只需要两处：属性（attr_* 是一句 call）和导入（require / include 也都是 call）。

/**
 * 一个节点 → 多个成员。为什么需要它：`attr_accessor :a, :b` 在语法树里**一句 call 带两个符号**，
 * 而成员路径上是“一个节点一个成员”，不特殊处理就会只记到第一个（2026-09-17 复查时实测到：b 丢了）。
 * （Ruby 里 attr_accessor 一次声明好几个属性是很常见的写法。）
 */
const rubyMembersOf = (node) => {
  if (node.type === 'call') {
    const m = node.childForFieldName('method');
    if (!m || !/^attr_(reader|writer|accessor)$/.test(m.text)) return null;
    const args = node.childForFieldName('arguments');
    const names = (args ? args.namedChildren : [])
      .filter((a) => a.type === 'simple_symbol')
      .map((a) => a.text.replace(/^:/, ''));
    return names.length ? names.map((n) => ({ kind: 'property', name: n })) : null;
  }
  const kind = { method: 'method', singleton_method: 'method' }[node.type];
  return kind ? [{ kind, name: rubyName(node) }] : null;
};

/** 属性名在参数里（不是 name 字段），所以得单独取：attr_accessor :size → size */
const rubyName = (node) => {
  if (node.type === 'call') {
    const args = node.childForFieldName('arguments');
    const first = args && args.namedChildren.find((a) => a.type === 'simple_symbol');
    return first ? first.text.replace(/^:/, '') : null;
  }
  const n = node.childForFieldName('name');
  return n ? n.text : null;
};

/** require 'json' / require_relative './x' / load 'y' → 依赖；include / extend / prepend → 混入 */
const rubyImportKind = (node) => {
  if (node.type !== 'call') return null;
  const m = node.childForFieldName('method');
  if (!m) return null;
  if (['require', 'require_relative', 'load'].includes(m.text)) return 'require';
  if (['include', 'extend', 'prepend'].includes(m.text)) return 'mixin';
  return null;
};

/** 取第一个参数当目标：'json' → json；Comparable → Comparable */
const rubyImportText = (node) => {
  const args = node.childForFieldName('arguments');
  const first = args && args.namedChildren[0];
  return first ? first.text : '';
};

export const LANGUAGES = {
  csharp: {
    id: 'csharp',
    label: 'C#',
    status: 'ok',
    exts: ['.cs'],
    wasm: 'c_sharp/tree-sitter-c_sharp.wasm',
    // 2026-09-17 升级语法包后，五条改写里四条不再需要（新语法原生认得原始字符串 / 主构造函数 /
    // file 修饰符 / void* 等，12 项实测均 0 ERROR）。只剩「局部变量名叫 required」还必须改：
    // 新旧语法都会把 `required = 1;` 里的 required 当修饰符关键字 → 整句 ERROR（真项目实测 3 处）。
    // preprocess.mjs 里的 csharp() 已经收窄成只做这一条。
    preprocess: 'csharp',
    // 参数名的标识符不算"引用"（否则参数名与类型重名时会产生假依赖）
    skipNameNodes: { parameter: 'name' },
    namespaces: { namespace_declaration: 1, file_scoped_namespace_declaration: 1 },
    // C# 10 的 `namespace Foo;`：整份文件都属于它。新版语法里它只包住名字，
    // 后面的类型是兄弟节点（旧语法是包在里面的）——不声明这条，所有类型都会落到 (global)。
    fileScopedNamespaces: ['file_scoped_namespace_declaration'],
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
    // 旧语法包把继承列表放在 base_list 字段里；换成 tree-sitter-wasm@2.0.1 的 C# 语法后
    // base_list 变成普通子节点（childForFieldName('bases') 取不到了），改走 baseNodes。
    baseFields: [],
    baseNodes: ['base_list'],
    decisions: [
      'if_statement', 'switch_statement', 'for_statement', 'foreach_statement',
      'while_statement', 'do_statement', 'catch_clause', 'conditional_expression',
      'switch_expression', 'case_switch_label', 'binary_expression',
    ],
    decisionOps: ['&&', '||', '??'],
  },

  typescript: { id: 'typescript', label: 'TypeScript', status: 'ok', exts: ['.ts', '.mts', '.cts'], wasm: 'typescript/tree-sitter-typescript.wasm', ...TS_SHAPE },
  // .tsx 必须用 tsx 语法：typescript 语法不认 JSX
  tsx: { id: 'tsx', label: 'TSX', status: 'ok', exts: ['.tsx'], wasm: 'tsx/tree-sitter-tsx.wasm', ...TS_SHAPE },

  javascript: {
    id: 'javascript',
    label: 'JavaScript',
    status: 'ok',
    exts: ['.js', '.mjs', '.cjs', '.jsx'],
    wasm: 'javascript/tree-sitter-javascript.wasm',
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
    wasm: 'java/tree-sitter-java.wasm',
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
    wasm: 'python/tree-sitter-python.wasm',
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
    wasm: 'kotlin/tree-sitter-kotlin.wasm',
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
    wasm: 'lua/tree-sitter-lua.wasm',
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
    wasm: 'bash/tree-sitter-bash.wasm',
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
    wasm: 'zig/tree-sitter-zig.wasm',
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
    wasm: 'solidity/tree-sitter-solidity.wasm',
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
    wasm: 'ocaml/tree-sitter-ocaml.wasm',
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
    wasm: 'rescript/tree-sitter-rescript.wasm',
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

  // ⚠️ SystemRDL 暂时缺席（2026-09-17）：上游没有任何 ABI 15 的 wasm（其 npm 包只有 C 源、
  // GitHub 仓库 0 个 release），我们自己编需要 emscripten，而本机三条路都被网络挡住：
  // GitHub release 资产下载被重置、Docker 镜像源对 emscripten/emsdk 返 403、emsdk 要 clone GitHub（时通时不通）。
  // 编出来之后把下面这段恢复、并把 vendor/wasm/tree-sitter-systemrdl.wasm 放好即可（步骤见 ROADMAP 附录 A.12）。
  //
  // systemrdl: {
  //   id: 'systemrdl',
  //   label: 'SystemRDL',
  //   status: 'ok',
  //   exts: ['.rdl'],
  //   wasm: 'tree-sitter-systemrdl.wasm',
  //   namespaces: {},
  //   types: { component_named_def: 'component', component_anon_def: 'component' },
  //   members: { component_inst: 'instance', property_assignment: 'property', explicit_prop_assignment: 'property' },
  //   imports: {},
  //   baseFields: [],
  //   baseNodes: [],
  //   decisions: [],
  //   decisionOps: [],
  // },

  // Emacs Lisp：没有“类型”这回事，顶层全是函数/变量 → 都挂到扫描器合成的 module 节点上
  elisp: {
    id: 'elisp',
    label: 'Emacs Lisp',
    status: 'ok',
    exts: ['.el'],
    wasm: 'elisp/tree-sitter-elisp.wasm',
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
    wasm: 'go/tree-sitter-go.wasm',
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
    wasm: 'rust/tree-sitter-rust.wasm',
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
    wasm: 'c/tree-sitter-c.wasm',
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
    wasm: 'cpp/tree-sitter-cpp.wasm',
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
    wasm: 'php/tree-sitter-php.wasm',
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
    wasm: 'swift/tree-sitter-swift.wasm',
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
    wasm: 'scala/tree-sitter-scala.wasm',
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
  // Elixir：全靠上面那组 elixir* 钩子（节点类型在这里没用）
  elixir: {
    id: 'elixir',
    label: 'Elixir',
    status: 'ok',
    exts: ['.ex', '.exs'],
    wasm: 'elixir/tree-sitter-elixir.wasm',
    namespaces: {},
    types: {},
    members: {},
    imports: {},
    baseFields: [],
    baseNodes: [],
    nameOf: elixirName,
    kindOf: elixirKind,
    memberKindOf: elixirMemberKind,
    importKindOf: elixirImportKind,
    importTextOf: elixirImportText,
    isDecision: elixirIsDecision,
    decisions: ['call'],
    decisionOps: [],
  },

  // Ruby：module 当命名空间（真实代码里就是靠模块嵌套分层），class 当类型；
  // attr_* 、require / include 全靠上面那组 ruby* 钩子。
  ruby: {
    id: 'ruby',
    label: 'Ruby',
    status: 'ok',
    exts: ['.rb', '.rake', '.gemspec'],
    wasm: 'ruby/tree-sitter-ruby.wasm',
    namespaces: { module: 1 },
    types: { class: 'class' },
    // 这张表实际被 membersOf 接管（后者优先）；留着是为了看表就知道 Ruby 有哪些成员声明
    members: { method: 'method', singleton_method: 'method' },
    imports: {},
    baseFields: ['superclass'],
    baseNodes: [],
    membersOf: rubyMembersOf,
    nameOf: rubyName,
    importKindOf: rubyImportKind,
    importTextOf: rubyImportText,
    decisions: ['if', 'unless', 'if_modifier', 'unless_modifier', 'case', 'while', 'until', 'for', 'rescue', 'rescue_modifier', 'binary'],
    decisionOps: ['&&', '||'],
    isDecision: (node) => {
      if (node.type !== 'binary') return true;            // 上面列的那些都是分支
      const op = node.childForFieldName('operator');
      return !!op && ['&&', '||'].includes(op.text);      // 算数比较不算复杂度
    },
  },

  // HCL / Terraform：没有类概念，图上的节点是 block（resource / variable / module / output / locals…），
  // 成员是块里的 attribute；引用靠标识符名字匹配（`data.aws_ami.ubuntu.id` 里的 `ubuntu`
  // 会连到 `data "aws_ami" "ubuntu"` 那个块）。
  hcl: {
    id: 'hcl',
    label: 'HCL / Terraform',
    status: 'ok',
    exts: ['.tf', '.tfvars', '.hcl', '.nomad'],
    wasm: 'hcl/tree-sitter-hcl.wasm',
    namespaces: {},
    // 注意：kindOf 存在时 types 会被忽略（kindOf 全权决定类别）；这两项一起写只是为了
    // 万一将来给 HCL 加 baseNodes（基类搜索会用到 types 表）时不至于缺东西。
    types: { block: 'block' },
    members: { attribute: 'attribute' },
    imports: {},
    baseFields: [],
    baseNodes: [],
    kindOf: hclKind,
    nameOf: hclName,
    decisions: [],
    decisionOps: [],
  },

  // GraphQL（SDL）：type / interface / union / enum / scalar / input / schema / directive 都是图上的节点，
  // 成员是 field / input 字段 / enum 值；`implements` 与 union 成员连成继承边。
  graphql: {
    id: 'graphql',
    label: 'GraphQL',
    status: 'ok',
    exts: ['.graphql', '.graphqls', '.gql'],
    wasm: 'graphql/tree-sitter-graphql.wasm',
    namespaces: {},
    types: {
      object_type_definition: 'type',
      interface_type_definition: 'interface',
      union_type_definition: 'union',
      enum_type_definition: 'enum',
      scalar_type_definition: 'scalar',
      input_object_type_definition: 'input',
      schema_definition: 'schema',
      directive_definition: 'directive',
    },
    members: {
      field_definition: 'field',
      input_value_definition: 'field',
      enum_value_definition: 'value',
    },
    imports: {},
    baseNodes: ['implements_interfaces', 'union_member_types'],
    baseFields: [],
    nameOf: gqlName,
    membersOf: gqlMembersOf,
    docstring: gqlDescription,
    decisions: [],
    decisionOps: [],
  },

  json: {
    id: 'json',
    label: 'JSON',
    status: 'ok',
    optIn: true,
    exts: ['.json', '.jsonc'],
    wasm: 'json/tree-sitter-json.wasm',
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
    wasm: 'yaml/tree-sitter-yaml.wasm',
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
    wasm: 'toml/tree-sitter-toml.wasm',
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
    wasm: 'css/tree-sitter-css.wasm',
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
    wasm: 'html/tree-sitter-html.wasm',
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
