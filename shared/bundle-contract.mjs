/** Shared by the engine, MCP and browser. Optional analysis fields remain optional. */
export const BUNDLE_SCHEMA = 'code-atlas/1';

export function validateBundle(bundle) {
  const fail = (field, expected) => { throw new Error(`Invalid bundle: ${field} must be ${expected}`); };
  const object = (value, field) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field, 'an object');
  };
  const array = (value, field) => { if (!Array.isArray(value)) fail(field, 'an array'); };
  const string = (value, field) => { if (typeof value !== 'string') fail(field, 'a string'); };
  const id = (value, field) => { if (!Number.isSafeInteger(value) || value < 0) fail(field, 'a nonnegative integer'); };
  const number = (value, field) => { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(field, 'a finite nonnegative number'); };
  object(bundle, 'root');
  if (bundle.schema !== BUNDLE_SCHEMA) throw new Error(`Unsupported bundle schema: ${String(bundle.schema)}; expected ${BUNDLE_SCHEMA}. Rescan with a compatible engine.`);
  object(bundle.source, 'source');
  array(bundle.source.roots, 'source.roots');
  bundle.source.roots.forEach((root, i) => string(root, `source.roots[${i}]`));
  object(bundle.generator, 'generator');
  string(bundle.generator.version, 'generator.version');
  string(bundle.generated, 'generated');
  object(bundle.totals, 'totals');
  for (const key of ['files', 'types', 'code', 'loc', 'comment', 'blank']) number(bundle.totals[key], `totals.${key}`);
  if (bundle.stats !== undefined) object(bundle.stats, 'stats');
  if (bundle.facets != null) {
    object(bundle.facets, 'facets');
    if (bundle.facets.systems !== undefined) array(bundle.facets.systems, 'facets.systems');
    (bundle.facets.systems || []).forEach((system, i) => {
      object(system, `facets.systems[${i}]`);
      string(system.name, `facets.systems[${i}].name`);
    });
  }
  for (const name of ['files', 'types', 'edges']) array(bundle[name], name);
  const uniqueIds = (records, field) => {
    const ids = new Set();
    records.forEach((record, i) => {
      object(record, `${field}[${i}]`);
      id(record.id, `${field}[${i}].id`);
      if (ids.has(record.id)) fail(`${field}[${i}].id`, 'unique');
      ids.add(record.id);
    });
    return ids;
  };
  const files = uniqueIds(bundle.files, 'files');
  const types = uniqueIds(bundle.types, 'types');
  const byType = new Map(bundle.types.map((type) => [type.id, type]));
  const reference = (value, ids, field) => { if (!ids.has(value)) fail(field, 'an existing id'); };
  bundle.files.forEach((file, i) => {
    for (const key of ['path', 'lang']) string(file[key], `files[${i}].${key}`);
    for (const key of ['loc', 'code', 'comment', 'blank']) number(file[key], `files[${i}].${key}`);
    array(file.types, `files[${i}].types`);
    file.types.forEach((type) => {
      reference(type, types, `files[${i}].types`);
      if (byType.get(type).file !== file.id) fail(`files[${i}].types`, 'owned by this file');
    });
    if (file.rootId !== undefined || file.relativePath !== undefined) {
      string(file.rootId, `files[${i}].rootId`);
      string(file.relativePath, `files[${i}].relativePath`);
      object(bundle.source.rootPaths, 'source.rootPaths');
      string(bundle.source.rootPaths[file.rootId], `source.rootPaths[${file.rootId}]`);
    }
    if (file.imports !== undefined) {
      array(file.imports, `files[${i}].imports`);
      file.imports.forEach((value) => string(value, `files[${i}].imports`));
    }
  });
  bundle.types.forEach((type, i) => {
    for (const key of ['name', 'fqn', 'ns', 'kind']) string(type[key], `types[${i}].${key}`);
    for (const key of ['loc', 'code', 'line', 'fanIn', 'fanOut']) number(type[key], `types[${i}].${key}`);
    if (type.members !== undefined) object(type.members, `types[${i}].members`);
    if (type.tags !== undefined) {
      array(type.tags, `types[${i}].tags`);
      type.tags.forEach((value) => string(value, `types[${i}].tags`));
    }
    reference(type.file, files, `types[${i}].file`);
    if (type.parent != null) reference(type.parent, types, `types[${i}].parent (${String(type.fqn || type.name)} → parent=${String(type.parent)})`);
    for (const key of ['bases', 'memberList']) array(type[key], `types[${i}].${key}`);
    type.bases.forEach((value) => string(value, `types[${i}].bases`));
    type.memberList.forEach((member, j) => {
      object(member, `types[${i}].memberList[${j}]`);
      string(member.n, `types[${i}].memberList[${j}].n`);
    });
  });
  bundle.edges.forEach((edge, i) => {
    object(edge, `edges[${i}]`);
    reference(edge.from, types, `edges[${i}].from`);
    reference(edge.to, types, `edges[${i}].to`);
    string(edge.kind, `edges[${i}].kind`);
    number(edge.w, `edges[${i}].w`);
  });
  // New fields (root identity, uses, tiers, diagnostics) are optional for older v1 graphs.
  return bundle;
}
