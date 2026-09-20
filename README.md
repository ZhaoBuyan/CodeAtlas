# Code Atlas

Turn **any source-code directory** into readable intermediate data (`bundle.json`), then browse it as a map in your browser.
Goal: one dataset serving two consumers — humans (explore, build a mental model) and AI (query it, save tokens).

Shape: **CLI + local web page** (nothing is uploaded; your code never leaves the machine).

> 中文版见 [README_CN.md](README_CN.md)（Chinese version）

**Docs in this repo**

| File | What it is |
| --- | --- |
| [README.md](README.md) · [README_CN.md](README_CN.md) | This document — what Code Atlas is, how it is built, what it can and cannot do (reference) |
| [USAGE.md](USAGE.md) · [使用说明.md](使用说明.md) | Step-by-step for **users**: first run, reading the map, connecting an AI, troubleshooting |
| [CHANGELOG.md](CHANGELOG.md) | Release notes — what changed in each version |
| [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) + [licenses/](licenses/) | Every bundled third-party component and its licence text, verbatim |
| [.github/workflows/ci.yml](.github/workflows/ci.yml) | How a release is produced (tests → two exes → GitHub Release on a `v*` tag) |

Where to look: **capabilities & limits** → “What it can read (input)” / “What is skipped by default” /
“What it cannot read”; **the MCP layer** → “For AI”; **day-to-day usage** → [USAGE.md](USAGE.md).

## What it is

Four things it aims for:

- **Local-first**: no sign-up, no upload, no cloud calls; works offline, your code stays on your machine;
- **Install-free**: one single-file exe (the full edition bundles a Node runtime) — double-click and go,
  no Node install, no environment setup;
- **One dataset, two consumers**: the same `bundle.json` — **humans** browse it in the browser
  (tree map / tree list / dependency graph / dependency matrix), **AI** queries it over MCP
  (9 tools, including token-budgeted export and impact analysis). You never re-parse just to feed an AI;
- **Honesty first**: whatever is uncertain is labelled (dependency edges are static name matching;
  unmatched and ambiguous references are counted; decompiled output is marked as having no source comments).
  It would rather show "I don't know" than pretend to be authoritative.

## Inspiration

[kolulu23/Zedema](https://github.com/kolulu23/Zedema)

## Quick start

**Option 1: the launcher (what you use day to day)**

Double-click `CodeAtlas.exe` in the repo root → drop a folder or file onto the input box
(or click "Folder…" / "File…") → click **Scan**.

- **The map is embedded in the window** (WebView2, Edge engine): same pages, same look as in a browser;
- Scan logs sit right below the map (toggle between "Show log" / "Show map");
- The "Open in browser" button is there for when you want a second window side by side;
- Closing the window stops the server.

The launcher needs the **WebView2 runtime** (built into Win11; present on Win10 with a recent Edge).
If it is missing you get no error — the page opens in your system browser instead.

```bash
CodeAtlas.exe                                # GUI
CodeAtlas.exe --auto "C:/path/to/repo"       # open the window and scan immediately (handy for a shortcut)
CodeAtlas.exe --headless --path <target> --out dist-test --log launcher-test.log   # headless self-check
```

**Option 2: command line (zero configuration)**

```bash
npm install

# Just hand it a path: source dir / assembly / jar all work; the browser opens when it's done
node src/cli.mjs "C:/path/to/your/repo"
node src/cli.mjs "C:/path/to/App.dll"
```

**Option 3: the individual commands**

```bash
node src/cli.mjs scan   <dir...> [--out dist] [--lang auto] [--maxkb 1024] [--exclude a,b] [--facets rules.json] [--open]
node src/cli.mjs ingest <dir|.dll|.exe|.jar> [--out dist] [--work ingest/<name>] [--dll "App*.dll"] [--decompiler cfr.jar] [--open]
node src/cli.mjs serve  [--out dist] [--port 5173] [--host 0.0.0.0]   # binds 127.0.0.1 by default
node src/cli.mjs langs                      # list supported languages (--json for machines)
node src/cli.mjs draft-facets <dir> [--out rules.json]   # draft a system-grouping rule file from the directory layout
node src/cli.mjs mcp    [--out dist] [--print-config]    # MCP server for AI clients
```

- `--no-open` does not open the browser; if `--port` is taken, the next free port is used
- `--lang` scans only the given languages: `--lang csharp` / `--lang typescript,lua`
- `--exclude` adds directory names to skip (node_modules / bin / obj / dist / build / target / vendor / .git … are already skipped)
- `--maxkb` per-file size limit
- The same commands exist as a global CLI: `npm i -g .` → `atlas scan <dir>` (the `atlas` alias is declared in
  `package.json`’s `bin`; without installing, `node src/cli.mjs …` does the same)

## The launcher (`CodeAtlas.exe`)

- A small .NET 9 WinForms shell: it finds the engine (`node` + `src/cli.mjs`), hands over the path,
  and shows you the log and the URL.
- **Configuring a project for the first time (project wizard)**: toolbar → "Project setup…", three steps:
  ① pick the target (dir / `.dll` / `.exe` / `.jar`) ② pick languages ③ **auto-draft a set of
  "system grouping rules" from the directory layout** (uncheck, rename, recolor as you like) → save and scan.
  Rules go to `%LocalAppData%\CodeAtlas\configs\<project>.facets.json` (**private**, never written into your
  project) unless you tick "write into the project directory", which writes `<project>/atlas.facets.json`
  (travels with the project, shareable).
  A configured project is remembered (languages + rules): **the next time you open it there is no wizard and
  nothing to re-configure**.
  CLI equivalent: `node src/cli.mjs draft-facets <dir> [--out file]` — reads the directory layout only,
  no parsing, instant.
- **No more firewall prompts**: the local server binds `127.0.0.1` only (loopback traffic bypasses the Windows
  firewall), so the "allow Node.js to communicate" dialog never appears.
  To view it from your LAN / phone: `atlas serve --host 0.0.0.0` (Windows will ask once; allow it).
- **Two convenient switches**: the toolbar "**Incremental**" checkbox (off by default = full scan every time;
  on = only re-parse changed files) and the "**MCP config**" button (copies the "let an AI read this project"
  configuration to your clipboard — paste it into your client, see
  [USAGE.md](USAGE.md) section 5).
  The language list comes from the engine (`node src/cli.mjs langs`); the launcher does not keep its own copy —
  adding a language only touches `languages.mjs`.
  Selected languages are stored in `launcher.config.json` under `Langs` (comma separated; empty = auto).
  Note this is a **global** setting, not per project.
- **UI language**: the toolbar button right after "Incremental" reads `界面：中文` / `UI: English` — one click
  switches the interface and saves the choice to `launcher.config.json`. It covers the launcher (run log, status
  bar, dialogs, error messages), the engine's scan output, all eight MCP tools **and** the web map. Switching
  does **not** re-scan anything: the bundle stores language-neutral values and the display layer maps them.
  Without the launcher, set `CODEATLAS_LANG=en` (the env var overrides the config; anything starting with `en` works).
- Requires **Node.js** (the engine is written in Node); no .NET SDK needed (but the .NET 9 runtime is,
  which the .NET 9 SDK includes).
- Configuration lives in `launcher.config.json` (node path / port / output dir / last path), created on first
  run — edit it if `node` is not on your PATH.
- Rebuilding: `dotnet publish launcher/CodeAtlas.Launcher.csproj -c Release -o .`
- Self-check (runs the engine headlessly to verify the wiring):
  `CodeAtlas.exe --headless --path <target> --out dist-test --log launcher-test.log`
  (add `--extract` to only verify extraction of the bundled engine; add `--list-langs` to only verify the
  language-table wiring)

### Snapshot / live mode

The launcher button is **two-state**: click once to go from “structure snapshot” to “structure monitor”.
In monitor mode the engine polls every 1.5 s and rescans **incrementally** (only the files that changed), and the map in
your browser updates by itself; the button shows “last update HH:MM”. “Scan” is disabled while monitoring (so two paths
never write the bundle at once), and “Stop” kills the child process too.

## Packaging and releases (two editions)

No installer — just an exe you can put anywhere.

| Edition | Build output | Size | What the machine needs first |
| --- | --- | --- | --- |
| **Full** | `publish-sc/CodeAtlas.exe` | 104.3 MB | nothing (bundles Node 24, the engine, and a trimmed Java runtime) |
| **Lite** | `publish-lite/CodeAtlas-lite.exe` | 10.1 MB | .NET 9 desktop runtime + Node.js |

```bash
npm run publish        # both editions (= publish:sc + publish:lite)
npm run publish:sc     # full only
npm run publish:lite   # lite only
```

One line on how it works: the engine (`src` / `web` / `configs` / 32 grammar wasm files / d3) is zipped by
`tools/build-payload.mjs` and embedded into the exe as an `<EmbeddedResource>`; on **first run** it is
extracted to `%LocalAppData%\CodeAtlas\engine\<version-payloadfingerprint>\` and reused from there.
What the full edition has beyond the lite one: `node.exe` in the payload (88 MB) plus the trimmed Java
runtime (about 30 MB).

- Extracted size: about 163 MB (full) / 45 MB (lite); delete it and it is re-extracted automatically.
  Old extraction directories for other versions are cleaned up **on every start**, keeping only the one in
  use plus the most recently used one — so switching versions does not leave ~160 MB behind each time.
- `dist/` and `ingest/` are written **next to the exe** (the engine directory is a cache; user data never
  goes in there).
- **Updating = replacing the exe.** A different version/payload fingerprint re-extracts the matching engine.
- The payload ships wasm only for the **28 code languages + 5 file-level formats** we support
  and nothing else (the unused grammars in the npm package stay out).
- Third-party components and licenses: see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
  (a copy also ships in the extracted engine directory).
- **Decompilation is install-free in the full edition**: `.dll` / `.exe` are decompiled by a decompiler
  linked into the launcher (ILSpy engine), `.jar` by the bundled trimmed Java runtime + cfr.jar —
  no ilspycmd / sfextract / Java to install. The lite edition carries no Java runtime (it already requires
  .NET 9 + Node), so scanning `.jar` there still needs a Java runtime.
- Development mode is unaffected: when `src/cli.mjs` sits next to the exe (e.g. the exe was copied into the
  repo), the repo engine is used instead of the bundled one.
**Official downloads**: every release ships both exes on [GitHub Releases](https://github.com/ZhaoBuyan/CodeAtlas/releases) —
built by CI from the tagged commit (the paths below are just where the local build puts them).

- **Release flow**: tag and push — `git tag v1.3.1 && git push origin v1.3.1` (push that one tag; **avoid `--tags`**,
  which would push local backup / experiment tags too). CI runs the tests, builds both exes
  and attaches them to a GitHub Release (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).
- **Three places carry the version** and have to move together: `launcher/CodeAtlas.Launcher.csproj`’s `<Version>`
  (what the exe and the window title show), `src/scan.mjs`’s `VERSION` (bundle metadata + the incremental cache
  fingerprint) and `package.json`’s `version`.

## Scanning without source (ingest)

```bash
# .NET assembly -> ILSpy decompile -> scan
node src/cli.mjs ingest "bin/Release/net9.0-windows10.0.19041.0/win-x64/App.dll" --out dist-app --open

# A directory: source is scanned directly; if it only holds build output, assemblies are picked by directory name
node src/cli.mjs ingest "C:/path/to/published-app" --out dist-app --dll "MyApp*.dll"

# Java jar (the full build ships the runtime + cfr; --decompiler overrides it)
node src/cli.mjs ingest "game.jar" --decompiler "C:/tools/cfr.jar"
```

Known limits:

- **Native executables (C/C++ builds) cannot be decompiled**: no CLR header, not a .NET assembly, and no type
  names / namespaces / method signatures inside — only machine code. Producing a map from that would require
  disassembling into approximate C first (the IDA / Ghidra class of work), which is out of scope.
  Pointing at such a file says "this is not a .NET assembly" and lists the three kinds that do work.
  **Exception: Unity games** — `<game>_Data\Managed\*.dll` *is* a .NET assembly; point at that directory or
  dll and it scans fine.
- **Decompiling needs no installs in the full edition**: `.dll` / `.exe` go through the decompiler **built into
  the launcher** (the ILSpy engine linked into the exe); `.jar` uses the **bundled trimmed Java runtime + cfr**.
  Running the engine directly (`node src/cli.mjs`) stays in development mode, where `.dll` / `.jar` need
  ilspycmd / java installed.
- Decompiled output has no source comments, so "description" is empty; line counts include expanded
  syntactic sugar (measured ~6% above source), and the UI says so.
- **Compiler-generated types are detected**: names like `<PrivateImplementationDetails>`, `_003C…`
  (ILSpy escaping), `__InlineArray`, `__DisplayClass` are tagged `compiler-generated` and hidden in the UI by
  default (there is a checkbox to show them).

## C# parsing (no preprocessing needed any more)

The bundled tree-sitter-c_sharp used to be a 2023 build that did not understand parts of C# 11/12 syntax and
marked whole regions as ERROR, so `src/preprocess.mjs` rewrote them into equivalent forms before parsing
(keeping line numbers and line counts identical, never touching strings or comments).

**That rewriting has been disabled since the 2026-09-17 grammar upgrade**: the new C# grammar understands
those constructs itself — 12 cases measured (raw strings, primary constructors, the `file` modifier, `void*`,
collection expressions, `required` members, `scoped ref`, static abstract members, lambda default parameters,
raw interpolated strings, a local variable named `required`, …) all parse with **zero ERROR nodes**. The old
rewrite even renamed a variable called `required` to `required_`, i.e. it got names wrong.
`src/preprocess.mjs` stays in the repo as a generic mechanism (if some language's grammar falls behind its
language version again, add `preprocess: 'xxx'` to that profile) — right now no language uses it.

## For AI: the MCP query layer

> **Setup steps (which button, where each client pastes the config, when to use each of the 9 tools,
> troubleshooting) are in [USAGE.md](USAGE.md) section 5 (Chinese: [使用说明.md](使用说明.md)).**
> Lazy path: scan once in the launcher → click "MCP config" → paste into your AI client.

After a scan, the AI does not need the source or the bundle in its context — it asks for small slices on demand:

```bash
node src/cli.mjs mcp --out dist        # stdio JSON-RPC for MCP clients
```

Tools provided:

| Tool | What it does |
| --- | --- |
| `overview()` | Project overview: size, system breakdown, most-depended-on symbols, largest files |
| `list(path?, limit?)` | **Browse by directory**: no `path` → the scan root; otherwise that level's folders / files with file, type and line counts. Start here when you do not know any names yet — its output (paths, file names) feeds `file()` / `search()` |
| `search(query, scope?, kind?)` | Find symbols by name; **member names are included by default** (searching `OnPaint` finds "who defines this method"); `scope=type\|member` narrows it. Hits carry the **signature** (parameter list + return type), so same-name overloads are told apart. Returns ids for the other tools |
| `symbol(name)` | Everything about one type: description, signature, file:line, member list (**with parameter list and return type**), base types, **reference counts (weighted)**, its system |
| `refs(name, in/out)` | Who references it / what it references (the blast radius before you change code); every edge carries `×count` and its evidence strength |
| `subgraph(name, depth)` | Dependency subgraph ("what does changing this drag along") |
| `file(path)` | A file's types, imports, line counts (**parse errors are called out when present**) |
| `map(budget)` | Exports a **skeleton** within a token budget (systems → key types → key members) so the AI gets the big picture cheaply |
| `impact(name, depth)` | **Impact analysis**: multi-hop expansion along "who references it", plus an explicit list of what is invisible (dynamic calls / reflection) |

Every tool lists a bounded number of entries and says "first N of M" when it truncates (`search` 20 · `symbol` members 40 · `subgraph` 40 per level · `list` 40 — raise with `limit` / `members`).
Each result ends with a **snapshot stamp (UTC)**, so even a single call tells you how fresh the data is.

Client configuration — the "MCP config" button copies exactly this shape (absolute paths, `command` already
pointing at the resolved `node.exe`, `env` set to the current UI language):

```json
{
  "mcpServers": {
    "code-atlas": {
      "command": "C:/path/to/node.exe",
      "args": ["C:/path/to/CodeAtlas/src/cli.mjs", "mcp", "--out", "C:/path/to/CodeAtlas/dist"],
      "env": { "CODEATLAS_LANG": "en" }
    }
  }
}
```

Four details:

- Output is **compact text, not JSON** — fewer tokens for the same question, and easier for a model to read;
- **The tool output follows the UI language**: the copied config carries `CODEATLAS_LANG`, so answers come back in
  the same language as your interface (the env var wins; delete it and the engine speaks Chinese);
- The bundle is a snapshot and can go stale. Before every call the server checks mtime and **switches to a
  freshly scanned bundle automatically**; it will not answer from yesterday's data;
- **The AI learns the boundaries on connect**: `initialize` carries an `instructions` field (how to use this
  data, and where it is not trustworthy), and the first screen of `overview` gives the **scan root**
  (so the AI can build absolute paths and read source itself), a **data snapshot** (generation time /
  language scope / per-file limit / incremental or not) and the **confidence caveat** (dependency edges are
  name matching, with unmatched and ambiguous counts).

Self-check: `node tests/mcp-selftest.mjs [dist]` (drives every tool over the real stdio protocol).

## Debugging tools

```bash
npm test                                          # language fixtures regression (28 languages, one process each)
npm run probe                                     # print the node names tree-sitter actually produces per language
node tests/probe-file.mjs <file> [--lang csharp]   # single-file probe: where the ERRORs are, which declarations are recognized
node tests/probe-abi.mjs                           # grammar smoke test (load + parse every wasm from both sources)
node tests/probe-grammars.mjs [--release] [--gc]   # grammar memory probe (where loading many grammars breaks, line by line)
node src/cli.mjs langs [--json]                    # list supported languages (--json for machines)
```

## What the UI can do

- **Grouping** (left panel): system / module (by rules) · directory · namespace · **file** · flat.
- **Group depth**: 1/2/3/4 levels or all — deeper means finer groups and more color blocks (for directory /
  namespace grouping).
- **Coloring**: **by file** (default: many colors, types from the same file share one) · by group (system
  grouping uses the colors configured in the rules) · by type kind. Colors come from a hue hash, so it is not
  limited to 10 colors and an item keeps the same color every time you open it.
- **Views**: tree map (areas) · tree list (collapsible, with proportion bars) · **dependency graph
  (force-directed)** · **dependency matrix (between modules)**
  - **Dependency graph**: dots and lines show what is connected to what; dot size = code volume, color follows
    the coloring mode; drag to reposition, wheel to zoom, hover to highlight neighbors; above 120 nodes it
    hides isolated ones, above 400 it draws only the most connected (the header says so)
  - **Dependency matrix**: rows/columns are the current grouping (directory / system …), cell darkness = number
    of edges between the two groups, the diagonal = internal coupling; the header tells you
    "the tightest coupling is A → B (N edges)"
- **Area metric**: code lines / total lines / complexity / member count / fanIn.
- **Drill-down**: click a group name, its border, or the legend on the left to see only that group; the
  breadcrumb takes you back.
- **Signatures**: the parameter list and return type are extracted from the syntax tree (`area(int, int): double`;
  for a property it is its declared type), so same-name overloads are no longer identical — and for JS/TS
  top-level functions and C#/Java `record` primary constructors the signature sits on the type itself.
  When the grammar does not expose it nothing is written: **blank means "not extracted", not "takes no arguments"**.
- **Descriptions**: extracted from source comments (C# `/// summary`, Java/TS block comments) at both type and
  member level, shown in the inspector and tooltips; only blank lines may sit between a comment and its
  declaration (otherwise the comment belongs to the previous declaration); when there is no comment it says
  "no comment in the source" rather than inventing one.
- **Dependency highlight**: hovering or selecting a type immediately lights up what it references and what
  references it, with connecting lines (blue for references, orange for inheritance). **One line per reference**:
  if B and C each reference A three times, six lines fan out of A's centre (three to B, three to C) — the line
  count *is* the reference count (the header also says "N lines = reference counts"). Everything else is dimmed.
- **Dependency focus** (checkbox): show only the selected type plus its relatives, with the relationship web
  drawn larger and clearer (the top-left corner tells you how many items are still shown).
- **A header line** states what the current chart encodes (grouping / depth / what area means / how it is
  colored); with a selection it also shows that type's reference counts, and warns when edges point outside
  the current grouping.
- **Inspector**: type details + description + file:line (copyable) + members (**with signature: parameter
  list + return type**) + who references it / what it references (clickable, jumping back to a grouping where the target is visible).
- **Filters**: type-kind checkboxes · **language checkboxes** (only languages actually present in this scan;
  the panel is absent when there is just one) · a minimum code-lines slider to hide small fragments.
- **Search (types + members)**: the input searches **member names too** (searching `OnPaint` finds "who defines
  this method", including prefixed ones like `OnPaintBackground`); results distinguish
  "matched member X (method) · file:line" from "matched type name". The query is part of the permalink (`q=`).
- **Permalinks**: view state lives in the URL (`#by=&v=&g=&t=&m=&c=&q=&l=`; `v=graph` / `v=matrix` share the
  graph or the matrix directly; `q=` / `l=` carry the search term and the language filter) — shareable and
  reproducible.

- **“Clear selection”** at the bottom-right of the map: clears the selection, empties the inspector, and drops the selection out of the URL hash.
- **Zoom / pan**: wheel to zoom, **right-drag to move the canvas** (the left button stays on select / drill-down), **“回正”** at the bottom-right resets to the whole map. Text scales with the zoom, and selecting a module no longer resets the zoom level.
- **The page reloads itself**: after you change anything under `web/`, any open page refreshes on its own — no F5 needed.

## Grouping rules (facets)

"View by system / module" is driven by a rule file, looked up automatically in this order:

1. `--facets <file>`
2. `<scan root>/atlas.facets.json`
3. `configs/<scanned dir name>.facets.json` in this repo

Too lazy to write one? **Let the tool draft it**: step 3 of the launcher's "Project setup…" wizard, or
`node src/cli.mjs draft-facets <dir> --out rules.json` (reads the directory layout only, no parsing, instant;
the output contains a `_comment` explaining the format — edit away).

```json
{
  "exclude": ["third_party"],
  "systems": [
    { "name": "UI layer", "color": "#f778ba", "files": ["*Form.cs"] },
    { "name": "Business modules", "color": "#58a6ff", "paths": ["Modules/**", "Services/**"] },
    { "name": "Utilities & infra", "color": "#bc8cff", "paths": ["Utils/**"], "namespaces": ["YourApp.Utils*"] }
  ]
}
```

- Rules are matched in order, **the first hit wins**; anything unmatched lands in `(uncategorized)`.
- `paths` / `files` / `namespaces` are globs (`**` crosses levels) matched against the file's relative path /
  file name / namespace / fully qualified name.
- `exclude` adds directories to skip (on top of the default ignore list).

## bundle structure (schema `code-atlas/1`)

| Field | Contents |
| --- | --- |
| `source` | scan roots, file count, **version stamp** (git commit + whether the tree was dirty; a timestamp when not a git repo), scan duration |
| `languages` | file count / line count per language |
| `files[]` | path, language, LOC (whole file) / code / comment / blank lines, import list, namespace |
| `types[]` | name, `fqn`, kind, namespace, `dir`, `system` + `systemRule` (which rule matched), **`doc`** (description from source comments), **`p` / `r`** (signature: parameter list / return type — both keys absent when not extracted), file + line, LOC (this type's range), member stats and list, base types, complexity, fanIn / fanOut |
| `namespaces` | package tree (with bottom-up totals: lines / type counts) |
| `edges[]` | type-level dependency edges: `ref` (reference) / `inherit` (inheritance), plus **weight = how many times the name was referenced inside the owning type** |
| `nsEdges[]` | namespace-level edges (used by the package dependency view) |
| `unresolved` | failed name resolutions (unknown / ambiguous) — the **confidence signal** |
| `facets` | system grouping result: which rule file was used, type/line/file counts per system, uncategorized count |

## Design principles

1. **Structure comes from parsing; dependencies are statistical inference.** Types / members / LOC come from
   the tree-sitter syntax tree and are trustworthy; reference edges come from identifier matching and will miss
   or mislink things — the UI labels this clearly instead of pretending both are equally authoritative.
2. **Version-stamped.** The bundle records the source commit and generation time, so humans and AI both know
   which revision they are looking at.
3. **Local-first.** Source never leaves the machine, the bundle stays local, and the tool only processes data —
   it never redistributes scanned code.
4. **Engine and host are decoupled.** The engine only produces `bundle.json`; the browser / MCP / future
   editor extensions are all consumers, so swapping a host does not touch the engine.

## What it can read (input)

| What you give it | What it does | Status |
| --- | --- | --- |
| **Directory with source** | Scans it; mixed languages in one pass | ✅ |
| **A single source file** | There is no "map of one file", so it scans the **containing directory** and tells you | ✅ |
| **.dll / .exe (.NET assembly)** | The launcher's **built-in decompiler** (ILSpy's library; only falls back to `ilspycmd` if you run the engine directly) → `.cs` → scan | ✅ measured |
| **.exe (.NET single-file publish)** | Unpacked by the built-in SingleFileExtractor → decompile → scan | ✅ measured |
| **Directory with build output only** | Finds assemblies by directory name; `--dll "App*.dll"` to be explicit | ✅ |
| **.jar (Java)** | The full build ships a **trimmed JRE + cfr** in `vendor/` — nothing to install → `.java` → scan (the lite build still needs Java on the machine) | ✅ measured (a 2.1 MB jar → 732 files / 1,015 types / 9,751 edges) |
| **Anything else** | Native binaries (`.so`/`.dylib`, or an exe/dll built from C/C++/Go/Rust) and archives (`.zip`/`.nupkg`/`.apk`) → refused, with a message listing the three kinds it does support | ❌ |

In the launcher you can drag in a folder, or a `.dll / .exe / .jar` — **you do not have to say which it is**.

**What it cannot read**: native executables (C/C++-built exe/dll — most applications and game binaries).
No CLR header, not a .NET assembly, no type names / namespaces / method signatures, only machine code.
Decompilation supports three things: **.NET assemblies**, **.NET single-file publishes**, **Java .jar**
(see the known limits under "Scanning without source" above).
Unity games are the exception: `<game>_Data\Managed\*.dll` is a .NET assembly, point at it and it scans.

### Supported languages (28 code languages)

| Language | Extensions | Status |
| --- | --- | --- |
| C# | `.cs` | ✅ measured (a 54-file / 106-type project) |
| TypeScript | `.ts` `.mts` `.cts` | ✅ measured (a 114-file / 367-type project) |
| TSX | `.tsx` | ✅ measured (JSX needs the separate tsx grammar) |
| Vue | `.vue` | ✅ measured (**only `<script>` / `<script setup>` is parsed** — templates and styles stay out; grammar borrowed from TSX, line numbers line up with the original file) |
| JavaScript | `.js` `.mjs` `.cjs` `.jsx` | ✅ measured |
| Java | `.java` | ✅ fixtures regression |
| Python | `.py` | ✅ fixtures (docstrings included) |
| Kotlin | `.kt` `.kts` | ✅ fixtures |
| Lua | `.lua` | ✅ fixtures (no type declarations → synthetic module node) |
| Go | `.go` | ✅ fixtures (struct / interface distinguished) |
| Rust | `.rs` | ✅ fixtures (trait/struct/enum/impl) |
| C | `.c` `.h` | ✅ fixtures (typedefs not double counted) |
| C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hxx` | ✅ fixtures (inheritance included) |
| PHP | `.php` | ✅ fixtures (class/interface/trait/enum + extends/implements) |
| Swift | `.swift` | ✅ fixtures (class/struct/enum/protocol distinguished) |
| Scala | `.scala` `.sc` | ✅ fixtures (class/object/trait) |
| Shell | `.sh` `.bash` `.zsh` | ✅ fixtures (no types → module node) |
| Zig | `.zig` | ✅ fixtures (const X = struct/enum) |
| Solidity | `.sol` | ✅ fixtures (contract/interface + inheritance) |
| OCaml | `.ml` `.mli` | ✅ fixtures (module/type; top-level lets get a synthetic module node) |
| ReScript | `.res` | ✅ fixtures (module / type / variant) |
| Ruby | `.rb` `.rake` `.gemspec` | ✅ fixtures (class/module; `module` acts as a namespace; `attr_*` become properties; `require`/`include` become edges) |
| HCL / Terraform | `.tf` `.tfvars` `.hcl` `.nomad` | ✅ fixtures (nodes are blocks: resource / data / module / variable / output / locals; members are attributes; references become edges) |
| GraphQL | `.graphql` `.graphqls` `.gql` | ✅ fixtures (type / interface / union / enum / scalar / input / schema / directive; fields are members, function arguments count as arguments; `implements` and union members become inheritance edges; `"""descriptions"""` become the "description") |
| TLA+ | `.tla` | ✅ fixtures (module + operator / variable) |
| SystemRDL | `.rdl` | ✅ fixtures (addrmap / reg / field components; the wasm is built by us — see the note below) |
| Emacs Lisp | `.el` | ✅ fixtures (no type concept → top-level functions/variables hang off a synthetic module node) |
| Elixir | `.ex` `.exs` | ✅ fixtures (module / function / struct; note `defmodule`/`def` are `call` nodes in the tree, recognized by dedicated hooks; `alias` counts as an import but is not linked into an edge yet) |

**No profile yet** (the grammar loads; what's missing is our layer): `Dart`, `Elm`, `QL`, `Haskell`,
`PowerShell`, `Julia`, `Vue`, `Svelte`…
`Vue` single-file components first need "parse the embedded `<script>`", and `Objective-C`'s `.m` clashes with
MATLAB — those two are deliberately deferred.
`TLA+` has no usable upstream wasm, so it is maintained in `vendor/wasm/`; the same goes for `SystemRDL` —
we compile it ourselves with emscripten (clang + wasm-ld, no emcc needed) and keep the wasm in `vendor/wasm/`
(recipe in `src/languages.mjs`).
Audit command: `node tests/probe-abi.mjs` (loads and parses every grammar from both sources, telling usable
from unusable).

**File-level formats (off by default, opt in explicitly)**: `JSON` `.json` · `YAML` `.yaml .yml` ·
`TOML` `.toml` · `CSS` `.css` · `HTML` `.html .htm` — they have no "types", so they only appear as files
(synthetic module nodes):

```bash
node src/cli.mjs scan ./repo --lang auto,json,yaml   # code languages + JSON/YAML
node src/cli.mjs scan ./repo --lang json,yaml        # config files only
node src/cli.mjs scan ./repo --lang cs               # C# only
```

**Grammars and "per-language child processes"**: with `web-tree-sitter` 0.27.0 a loaded grammar now occupies
about **11 MB** (it used to be 150–180 MB), and 105 grammars in one process stay in the 1.2 GB range
(measured: 20 grammars = 104 MB, and a natural exit with code 0). The per-language child process **remains**,
but for a different reason: **crash isolation** — when a grammar hard-aborts on some input (a wasm-level abort
that JS cannot catch), only that language is lost and the rest still make it into the map. For reference, the
old runtime crashed with 9 grammars in one process (exit code `0xC0000409`), while 1–3 were fine.
Note this is **not** "not enough memory": on this machine Node can allocate 50 GB+ before that becomes the
story.

**So this is how a scan runs**: the parent process only collects files, builds indexes and writes the bundle —
**each language is parsed in its own child process** (one grammar per child).

- Peak memory = one language (about 50 MB), and it no longer stacks up with the number of languages;
- If a child dies, only that language is lost (the report says so) and the others still land in the map;
- The parent never loads wasm, so it **exits cleanly with a correct exit code** — the old "crashes on exit"
  class (Swift/Scala) is gone;
- The cost: a few extra process starts (about 0.2 s per language).

Tuning it: `npm run probe:mem` (grammar memory probe, written line by line to disk).

**Grammar sources and scale** (to add one, write a profile in `src/languages.mjs` — usually 5–10 lines):

- Primary source: the npm package `tree-sitter-wasm` (**105 grammars**; current runtime `web-tree-sitter`
  0.27.0, compatible with grammar ABI 13–15);
- Maintained by us: `vendor/wasm/` (TLA+; SystemRDL, compiled with emscripten);
- Full smoke test: `npm run probe:abi` → every wasm from both sources loads and parses.

Adding a language = add a profile in `src/languages.mjs` (node types + inheritance fields + complexity branch
table), drop a sample into `tests/fixtures/<language>/`, write the expectations in
`tests/run-fixtures.mjs`, then `npm test`. When unsure about node names, run `npm run probe` first
(it prints the node names tree-sitter actually produces — do not guess).

**Files without type declarations** (scripts, top-level functions, Lua modules) get a synthetic `module` node
so the whole file does not vanish from the map; their members (functions/variables) hang off that module node.

### What is skipped by default

- **Directories**: `.git` `.svn` `node_modules` `bin` `obj` `dist` `build` `out` `target` `vendor`  `.vs` `.vscode` `.idea` `.venv` `__pycache__` `coverage` `.next` `.nuxt` `publish*`;
  (**`packages/` is not on the list** — it is the source root of pnpm / yarn workspaces / lerna / Nx / Turborepo,
  and skipping it turns such a monorepo into a nearly empty map)
- **Files**: minified / auto-generated ones (`*.min.js` `*.d.ts` `*.g.cs` `*.designer.cs` `*.generated.cs/ts`
  `*.freezed.dart` `*.g.dart`) plus **machine-generated lockfiles** (`package-lock.json` `pnpm-lock.yaml` `yarn.lock`
  `bun.lockb` `*.lock` `Cargo.lock` `poetry.lock` `composer.lock` `Gemfile.lock` `go.sum` `gradle.lockfile`
  `.terraform.lock.hcl`, Yarn PnP's `.pnp.cjs`) and `*.snap` / `*.js.map` / `*.css.map` — a single `pnpm-lock.yaml`
  can account for 97% of the “lines of code” in a map;
- **Skipped directories are named**: the scan report prints a line like “Skipped dirs node_modules 312 · dist 4 …”,
  and `overview` does the same — so “something is missing from the map” is never something you have to guess;
- **Any file > 1 MB** (`--maxkb` to change);
- **Whatever your project rules say**: `facets.json`'s `exclude` adds directories to ignore (upstream
  reference code, for instance). Better still, drop an **`atlas.ignore`** at the **scan target root**
  (`dirname` / `dirname/` / globs like `*.gen.ts` / `#` comments, one per line — read **only if the file exists**);
  the launcher's **「扫描范围」** picker (last item: **「按 .gitignore 跳过」**) or `--gitignore` on the CLI additionally honors the project's own
  `.gitignore` — **including the ones inside subdirectories**, with git's semantics: each file's rules only apply to its own
  subtree (so a monorepo does not come out half-empty); directories that are excluded are not descended into.
  Whatever gets skipped is named in the report (along with how many rule files were read; `!` negations are not supported yet — also reported).

### What to watch out for when scanning

- **Pick the right languages for a clean result**: the default `auto` scans all code languages and **skips**
  file-level formats like `JSON/YAML/TOML/CSS/HTML` (name them explicitly as `--lang auto,json` to include
  them). Ticking only the languages your project actually uses is markedly faster and keeps foreign languages
  from dependency directories out of the map (there is a checkbox panel in the launcher, stored globally in
  `Langs`).
- **Files are read as UTF-8**: files in another encoding (GBK, …) are **detected and flagged** — the scan report,
  the MCP `overview` and a chip in the web UI all say how many files are affected (`totals.nonUtf8Files`).
  Their comments/strings show up as mojibake even when the parse itself succeeds (so there is no “parse error”),
  and converting them to UTF-8 gives back clean text on the next scan.
- **What incremental scanning relies on**: `--incremental` decides cache validity from an engine fingerprint
  (version + mtimes of `scan.mjs`/`languages.mjs`/`preprocess.mjs`). Change the version or those files and the
  cache is discarded and a full scan runs — it will not quietly answer with results produced by old rules.
- **Look at `unknown` / `ambiguous` first**: dependency edges are **name-matching** level, so same-named
  symbols in different scopes may stay unmatched or be mislinked; those two counts are the "I am not sure here"
  signal. They appear in the report, in the UI and in `bundle.json` — check them before trusting conclusions.
- **Parse failures are not silent**: a file with ERROR nodes or a grammar that failed to run this time only
  affects that slice, and the report names it (the bundle also records `source.failedLanguages`).
- **Large repos**: ① restrict languages first; ② the default 1 MB per-file limit (`--maxkb`) skips huge files
  outright; ③ turn on incremental for the second pass.
- **Source never leaves the machine**: the local server binds `127.0.0.1`, MCP runs over local stdio, and
  scanning never goes online (use `--host 0.0.0.0` only to view the map from your LAN).
- **`dist/` and `ingest/` land next to the exe**: the engine extraction directory
  (`%LocalAppData%\CodeAtlas\engine\<version-fingerprint>\`) is a cache — delete it and it is re-extracted;
  old caches from other versions are cleaned up on every start (only the current one and the most recently
  used one are kept).

### What it cannot read (the boundaries, stated plainly)

1. **Unsupported languages** (Dart / Haskell / Svelte…) are skipped, but **not silently** — the report and the UI
   both show "unsupported languages: N files (.dart 2 · .vue 1 …)". The same principle covers skipped **directories**:
   a header chip says "skipped 10 dir names (10) · 3 by project rules" and its tooltip names them (and which rule
   file they came from). There is also an easily confused case:
   files in a language we *do* support but that were outside this scan (that language was not ticked, or a
   file-level format like JSON/YAML that is off by default) are reported separately as
   "**out of language scope**: N files not scanned", never counted as unsupported;
2. **Decompiled output**: no source comments (so "description" is empty), line counts higher than source
   (syntactic sugar is expanded), plus compiler-generated types (auto-tagged and hidden in the UI by default);
3. **The limits of static analysis**: reflection, dynamic `import`, and methods invoked through concatenated
   strings **are not visible**; dependency edges are name-matching level and same-named symbols can be
   mislinked (the UI shows the unknown / ambiguous counts);
4. **Not read**: binary assets, images, config file contents, runtime behaviour, git history.

## Features (everything listed here is shipped — no wishlist)

Every item below is in the current build; what changed in each version lives in [CHANGELOG.md](CHANGELOG.md).

- [x] v1: CLI scan + local web UI (tree map / tree list / inspector / permalinks)
- [x] Grouping layer: system rules (facets config) + directory / namespace / flat
- [x] MCP server (search symbols / find references / export subgraphs) for AI
- [x] Language coverage: 28 code languages + 5 file-level formats
- [x] Dependency graph view (force-directed) + package-level dependency matrix
- [x] Pick languages to scan in the launcher (UI + `--lang`)
- [x] Search improvements: type names + member names (web and MCP) · per-language filtering in the map
- [x] Packaging: two single-file exes — full (bundled Node) / lite (system Node), no installer
- [x] First-run wizard (pick project → draft grouping rules → pick languages → save and scan; no wizard next time)
- [x] Incremental scanning (`--incremental`, re-parses changed files only; "Incremental" checkbox in the launcher)
- [x] **Scanning without source**: `.dll / .exe` (including .NET single-file publishes) via the launcher's built-in decompiler · `.jar` via the bundled trimmed JRE + cfr — the full build needs nothing installed
- [x] **Parser upgrade**: web-tree-sitter 0.20 → 0.27 with 105 grammar packages (one grammar used to cost 150–180 MB; now ~11 MB)
- [x] **Honesty as a feature**: unknown / ambiguous edge counts, files that are not UTF-8, unsupported languages and "supported but out of the scanned range" files are each reported separately — nothing is dropped silently
- [x] Headless self-check and diagnostics in the same exe (`--headless --path <dir> --log <file>`, `--list-langs`, `draft-facets`) — useful when somebody reports a problem
- [x] AI interface hardening: one-click MCP config copy · `map(budget)` skeleton export · `impact` blast radius (multi-hop + honest caveats)
- [x] UI language: 中文 / English across the launcher, the engine's output, all MCP tools and the web map (switching needs no re-scan) — the docs come in both languages too ([README_CN.md](README_CN.md) · [USAGE.md](USAGE.md))

- **git heat coloring**: files are colored by how often git touched them, so the busiest code stands out (uncommitted files get a bright border)
- **Snapshot / monitor mode** in the launcher: edit your code and the map updates incrementally — no full rescan, no page refresh
- **“Clear selection”** at the bottom-right of the map; hovering or clicking a module's *name* now hits the module itself
- **Evidence strength on refs**: every reference is tagged same-file / import / name-only, and the overview hot list ranks by evidenced references

## License

MIT (see [LICENSE](LICENSE)).
