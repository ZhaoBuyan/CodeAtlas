/** Bounded diagnostics only: resolution counts, never dependency edges or token counts. */
export function createUnresolvedDetails({ ambiguous = 50000, unknown = 1000 } = {}) {
  const limits = { ambiguous, unknown };
  if (Object.values(limits).some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid unresolved detail limits');
  const entries = new Map();
  const groups = { ambiguous: 0, unknown: 0 };
  const droppedByKind = { ambiguous: 0, unknown: 0 };
  return {
    record(file, lang, name, kind, reason = kind) {
      if (!Object.hasOwn(limits, kind)) throw new Error('Invalid unresolved kind');
      if (typeof name !== 'string' || name.length > 512) { droppedByKind[kind]++; return; }
      const key = JSON.stringify([file, lang, name, kind, reason]);
      const current = entries.get(key);
      if (current) { current.n++; return; }
      if (groups[kind] >= limits[kind]) { droppedByKind[kind]++; return; }
      entries.set(key, { file, lang, name, kind, reason, n: 1 });
      groups[kind]++;
    },
    snapshot() {
      const dropped = droppedByKind.unknown + droppedByKind.ambiguous;
      return { entries: [...entries.values()], limit: ambiguous + unknown, limits: { ...limits },
        droppedByKind: { ...droppedByKind }, dropped, truncated: dropped > 0 };
    },
  };
}

export function queryUnresolved(bundle, { lang = '', file = '', limit = 20 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
  const details = bundle.stats?.unresolved?.details;
  const counts = bundle.unresolved;
  const totals = counts && ['unknown', 'ambiguous'].every((k) => Number.isSafeInteger(counts[k]) && counts[k] >= 0) ? counts : null;
  if (!Array.isArray(details?.entries)) return { available: false, totals };
  const language = lang.trim().toLowerCase(), fragment = file.trim().replaceAll('\\', '/').toLowerCase();
  const files = new Map(bundle.files.map((f) => [f.id, f]));
  const drops = details.droppedByKind;
  if (drops !== undefined && (!drops || ['unknown', 'ambiguous'].some(k => !Number.isSafeInteger(drops[k]) || drops[k] < 0)
    || drops.unknown + drops.ambiguous !== details.dropped)) throw new Error('Invalid unresolved details; rescan with the current engine');
  if (!Number.isSafeInteger(details.dropped) || details.dropped < 0 || details.truncated !== (details.dropped > 0)
    || details.entries.some((r) => !r || !files.has(r.file) || typeof r.lang !== 'string' || typeof r.name !== 'string'
      || typeof r.reason !== 'string' || !['unknown', 'ambiguous'].includes(r.kind) || !Number.isSafeInteger(r.n) || r.n < 1)) {
    throw new Error('Invalid unresolved details; rescan with the current engine');
  }
  const rows = details.entries.filter((r) => (!language || r.lang.toLowerCase() === language)
    && (!fragment || (files.get(r.file)?.path || '').replaceAll('\\', '/').toLowerCase().includes(fragment)));
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify([r.lang, r.name, r.kind, r.reason]);
    const group = groups.get(key) || { lang: r.lang, name: r.name, kind: r.kind, reason: r.reason, n: 0, files: new Set() };
    group.n += r.n; group.files.add(files.get(r.file)?.path || '?'); groups.set(key, group);
  }
  const ranked = [...groups.values()].sort((a, b) => b.n - a.n || a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name) || a.reason.localeCompare(b.reason));
  return { available: true, totals, matched: rows.reduce((n, r) => n + r.n, 0), groups: ranked.length,
    truncated: details.truncated === true, dropped: details.dropped || 0,
    ...(drops ? { droppedByKind: { ...drops } } : {}),
    top: ranked.slice(0, limit).map((r) => ({ ...r, fileCount: r.files.size, files: [...r.files].sort().slice(0, 3) })) };
}
