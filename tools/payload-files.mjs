import fs from 'node:fs';
import path from 'node:path';

// Deliberate release surface. A local scratch file cannot opt itself into a release.
export const RUNTIME_FILES = [
  'src/cli.mjs', 'src/fsx.mjs', 'src/i18n.mjs', 'src/ingest.mjs',
  'src/languages.mjs', 'src/mcp.mjs', 'src/modules.mjs', 'src/preprocess.mjs',
  'src/scan.mjs', 'src/storage.mjs', 'src/version.mjs', 'src/git-metadata.mjs', 'src/unresolved.mjs', 'shared/bundle-contract.mjs',
  'web/app.js', 'web/bundle-loader.js', 'web/query-model.js', 'web/index.html', 'web/style.css', 'web/icon.png', 'web/icon.svg',
];
export function payloadSourceFiles(root, { allConfigs = false } = {}) {
  const configs = allConfigs
    ? fs.readdirSync(path.join(root, 'configs')).filter((name) => name.endsWith('.json')).sort().map((name) => `configs/${name}`)
    : ['configs/example.facets.json'];
  return [...RUNTIME_FILES, ...configs];
}
