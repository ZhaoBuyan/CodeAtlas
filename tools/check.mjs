import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkEnvironment } from './check-environment.mjs';

export function checkPlan({ mode = 'self', launcher = false } = {}) {
  if (!['self', 'ci', 'both'].includes(mode)) throw new Error(`Unknown check mode: ${mode}`);
  const plan = [
    ['version', ['tools/check-version.mjs', ...(launcher ? ['--launcher'] : [])]],
    ['check environment', ['--test', 'tests/probe-check-environment.mjs']],
    ['Git heat equivalence', ['--test', 'tests/probe-git-heat.mjs']],
    ['packaged runtime dependencies', ['--test', 'tests/probe-runtime-surface.mjs']],
    ['languages', ['tests/run-fixtures.mjs']],
    ['Python binding boundaries', ['--test', 'tests/probe-python-bindings.mjs']],
    ['TS catch scope boundaries', ['--test', 'tests/probe-ts-catch.mjs']],
    ['Go qualified provenance', ['--test', 'tests/probe-go-qualified.mjs']],
    ['Haskell module scopes', ['tests/probe-haskell.mjs']],
    ['Clojure nominal scopes', ['tests/probe-clojure.mjs']],
    ['Elm module scopes', ['tests/probe-elm.mjs']],
    ['C# private ancestor visibility', ['tests/probe-csharp-ancestors.mjs']],
    ['C# method declaration roles', ['tests/probe-csharp-methods.mjs']],
    ['C# invocation roles', ['tests/probe-csharp-calls.mjs']],
    ['C# member invocation roles', ['tests/probe-csharp-member-calls.mjs']],
    ['Java/Rust/PHP member declaration roles', ['tests/probe-member-declarations.mjs']],
    ['Scala method declaration roles', ['tests/probe-scala-declarations.mjs']],
    ['web colors', ['tests/probe-web-color.mjs']],
    ['payload path quoting', ['tests/probe-payload-quote.mjs']],
    ['runtime', ['tests/probe-runtime.mjs']],
    ['scan integrity', ['tests/probe-scan-integrity.mjs']],
    ['update and query models', ['--test', 'tests/probe-bundle-updates.mjs', 'tests/probe-query-model.mjs', 'tests/probe-unresolved.mjs']],
  ];
  if (mode !== 'ci') plan.push(['scan self', ['tools/scan-self.mjs']], ['MCP self graph', ['tests/mcp-selftest.mjs']]);
  if (mode !== 'self') plan.push(['scan CI graph', ['src/cli.mjs', 'scan', 'tests/fixtures', '--out', 'tests/.out/ci', '--lang', 'csharp,typescript,javascript,tsx,go,rust,lua']],
    ['MCP CI graph', ['tests/mcp-selftest.mjs', 'tests/.out/ci']]);
  if (launcher) plan.push(['launcher build', ['tools/build-launcher.mjs']], ['launcher headless', ['tests/probe-launcher.mjs']]);
  return plan;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const modeIndex = process.argv.indexOf('--mode');
    const plan = checkPlan({ mode: modeIndex < 0 ? 'self' : process.argv[modeIndex + 1], launcher: process.argv.includes('--launcher') });
    if (process.argv.includes('--list')) console.log(JSON.stringify(plan, null, 2));
    else {
      const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
      const env = checkEnvironment(root);
      for (const [label, args] of plan) {
        console.log(`\n[check] ${label}`);
        const result = spawnSync(process.env.NODE_BIN || process.execPath, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
        if (result.status !== 0) throw new Error(`${label} failed: ${result.error?.message || result.signal || result.status}`);
      }
      console.log('\nAll requested checks passed.');
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
