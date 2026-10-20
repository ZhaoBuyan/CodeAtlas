import fs from 'node:fs';
import path from 'node:path';

// Only the check runner's children inherit this environment. Production scans
// keep the caller's environment and repository discovery behavior.
export function checkEnvironment(root, parent = process.env) {
  const base = path.join(root, 'build', 'check-temp');
  fs.mkdirSync(base, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(base, 'run-'));
  const ceilings = [temporary, path.join(root, 'tests', '.out'), parent.GIT_CEILING_DIRECTORIES]
    .filter(Boolean).join(path.delimiter);
  return { ...parent, TEMP: temporary, TMP: temporary, TMPDIR: temporary, GIT_CEILING_DIRECTORIES: ceilings };
}
