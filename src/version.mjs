import fs from 'node:fs';

// package.json is the canonical product version, including in extracted payloads.
export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
