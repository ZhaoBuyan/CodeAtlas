# Code Atlas — Usage guide

> Chinese version: [使用说明.md](使用说明.md)

In one line: **drop this exe on any codebase and it turns the code into a map you can look at, search and click
through** — so you can figure out "what is in here, and who uses whom" in an unfamiliar project. Everything runs on
your own machine: nothing is uploaded, nothing talks to the network.

---

## 1. Getting started (one minute)

1. **The file you downloaded is `CodeAtlas.exe`** (about 104 MB, no install needed). You can put it anywhere —
   Desktop, D:, a USB stick.
2. **Double-click it.** The first launch spends a few seconds "unpacking the built-in engine" (about 160 MB, once
   only), then the **Project setup** wizard opens:

   | Step | What you do |
   | --- | --- |
   | ① Pick a project | Hit "Choose folder…" and pick a source directory (you can also pick a `.dll` / `.exe` / `.jar` — it decompiles first, then scans) |
   | ② Pick languages | "Auto" is fine (all code languages). Tick only what this project uses if you want it faster |
   | ③ Grouping rules | It **drafts a "system" grouping from the directory structure** (Utils / Players / UI…). Untick what you do not want; names and colors are editable |

3. Hit **"Save and scan"** — the map appears in the same window when the scan finishes.
4. **Next time you open this project: just hit "Scan"** — languages and grouping rules are remembered.

> For another project: hit **"Setup…"** on the toolbar and go through the wizard again (each project keeps its own
> settings).

> **Interface language**: the toolbar button reads `UI: English` (click it to switch back to `中文`). It covers the
> launcher, the scan output, the AI interface and the web map at once, and it **does not re-scan** — the choice is
> remembered. If you do not use the launcher, set the environment variable `CODEATLAS_LANG=en` instead.

---

## 2. Reading the map

Filters on the left, the map in the middle, details on the right.

| What you want | How |
| --- | --- |
| Another view | Bottom-left "View": **Treemap** (area = code size) / **Tree list** / **Dependency graph** (who links to whom) / **Dependency matrix** (how often modules reference each other) |
| Look by module | "Group by": system (your drafted rules) / directory / namespace / flat; "Group depth" 1–4 |
| Find something | The search box at the top — **type names and member names both match**: search `OnPaint` and it finds "who defines this method" |
| Inspect something | Click a block → the inspector on the right shows what it is, file and line, its members, what it depends on, what depends on it |
| See "who references whom" | Tick "Dependency focus", or select a block and look at its links |
| Make sense of the colors | "Color by": file / group / kind |
| Too noisy | The "Min code lines" slider drops small fragments; "Type kinds" keeps only class / interface and friends |
| Share a view | The address bar *is* the full state (`#q=OnPaint&v=graph`…) — copy it and someone else sees the same picture |

Small tip: **dark blocks** are things outside the current filter/search, not an error.

---

## 3. Things you may run into

- **Windows says "Windows protected your PC / unknown publisher"**: the exe has no code-signing certificate. Click
  "More info" → "Run anyway".
  (The full build is self-contained and needs no .NET. `CodeAtlas-lite.exe` next to it is the lite build: it requires
  .NET 9 and Node.js on the machine — most people do not need it.)
- **The first launch takes a few seconds**: that is it unpacking the engine into
  `%LocalAppData%\CodeAtlas\engine\`. **Once only**; delete that folder and it rebuilds itself.
- **Does it modify my code?** No. It only reads it; grouping rules go to `%LocalAppData%\CodeAtlas\configs\` by
  default (an `atlas.facets.json` is written inside your project only if you tick "write into the project directory"
  in the wizard).
- **Some numbers say "unknown / ambiguous"**: dependencies are decided by **static name matching**, so same-named
  types and dynamic calls are honestly marked instead of guessed (unresolved, ambiguous, confidence).
- **Uninstalling**: delete the exe; then delete `%LocalAppData%\CodeAtlas` and nothing is left.
- **Slow or stuck**: tick fewer languages in "Setup…" (only what the project really uses) — big repos get much faster.
- **You changed a few files and want to look again**: no need to wait for a full scan — tick **"Incremental"**
  (section 6).

---

## 4. What it is, and what it is not

**It is** a "look at the picture" tool. It scans your own codebase (or someone else's open-source repo, or a
decompiled assembly) into intermediate data so that **you** can browse it, search it and click through it — the first
step towards understanding unfamiliar code.

**It is not** a decompiler, an IDE, or "ask the AI". It does not pretend to be authoritative: every inference carries
its source and its uncertainty, and nothing is uploaded to any server.

Languages: C# / TypeScript / TSX / JavaScript / Java / Python / Kotlin / Lua / Go / Rust / C / C++ / PHP / Swift /
Scala / Shell / Zig / Solidity / OCaml / ReScript / Ruby / HCL (Terraform) / GraphQL / TLA+ / Emacs Lisp / Elixir
(26 in total; SystemRDL is still missing until its grammar is packaged), plus file-level formats such as JSON / YAML /
TOML / CSS / HTML (off by default — tick them explicitly under "Setup… → Languages").

---

## 5. For AI (optional, but a big token saver)

Code Atlas ships an **MCP server**: once connected, an AI (Chatbox / Claude / Cursor / Windsurf / Cline…) can
**query** this codebase instead of you pasting files into the chat — **tens of times fewer tokens, and the answers
come with sources**. It reads the local scan result: **no re-scan, no upload**.

### 5.1 Hook it up in two steps (recommended)

1. In the launcher, hit **"Scan"** once for this project (produces `dist/bundle.json`);
2. Hit **"MCP config"** on the toolbar → "copied to clipboard" → paste that JSON into your AI client's MCP config →
   restart the client.

What gets copied looks like this (all paths are **absolute**, nothing to edit):

```json
{
  "mcpServers": {
    "code-atlas": {
      "command": "C:/path/to/node.exe",
      "args": ["C:\\path\\to\\CodeAtlas\\src\\cli.mjs", "mcp", "--out", "C:\\path\\to\\CodeAtlas\\dist"],
      "env": { "CODEATLAS_LANG": "en" }
    }
  }
}
```

> `command` is already the **resolved absolute path to node** (the built-in `node.exe` in the full build), so it keeps
> working on another machine; both paths in `args` are absolute too. `env.CODEATLAS_LANG` decides which language the
> AI's answers come back in (it follows the interface; use `zh` for Chinese).

### 5.2 Where to paste it

| Client | Where |
| --- | --- |
| **Chatbox** | Settings → MCP / extensions → add server (paste the `mcpServers` snippet) |
| **Claude Desktop** | the `mcpServers` field in `%APPDATA%\Claude\claude_desktop_config.json` |
| **Cursor** | Settings → MCP → Add new MCP server (or `~/.cursor/mcp.json`) |
| **Windsurf / Cline / others** | find the "MCP servers" setting and paste the `mcpServers` snippet |

**Restart the client** afterwards; you should see a `code-atlas` server with 8 tools.

### 5.3 What you can ask once it is connected (8 tools)

| Tool | When to use it |
| --- | --- |
| `overview` | Get the lay of the land first: how much is there, where the usual entry points are |
| `search(query, scope?)` | Find symbols — **member names are searched too** ("who defines `OnPaint`?"), with type hits and member hits separated |
| `symbol(name)` | Details of one type: members, bases, reference count |
| `refs(name, dir?)` | Who references it / what it references |
| `subgraph(name, depth)` | The dependency subgraph around one place |
| `map(budget)` | Export a **token-budgeted** skeleton (systems → key types → key members) |
| `impact(name, depth)` | **Blast radius**: who is affected if you change it (multi-hop) |
| `file(path)` | The types inside one file |

Suggested flow: **`map` for the big picture → `search` to locate → `symbol` / `refs` / `impact` to go deep**. Far
cheaper than having the AI read files one by one.

### 5.4 What it does not know (honesty section)

- Dependency edges are **static name matches**: dynamic calls, reflection and string-built names are **invisible**;
- `map` / `overview` state how many references did not match any type (**unknown**) or matched several
  (**ambiguous**) — those are genuinely uncertain;
- To keep answers in sync with the code: **re-scan** after editing (tick "Incremental", it is quick) — the server
  picks up the new result automatically.

### 5.5 Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| No `code-atlas` in the client | The config went in the wrong place, or the client was not restarted; **backslashes must be escaped** (`\\`) in JSON — what the launcher copies is already escaped |
| Connected, but it says "no data" | `--out` points at the wrong directory, or that project was never scanned (hit "Scan" once) |
| "`node` not found" | Only happens with hand-written configs (it relies on PATH); the one the launcher copies already has an absolute `command` |
| The AI still gives stale answers after you edit code | Re-scan (tick "Incremental") — the server reloads automatically |

> Not connecting an AI at all is perfectly fine: **browsing the map yourself** is the main point of this tool.

---

## 6. One switch that saves time: Incremental

The toolbar has an **"Incremental"** checkbox (off = full scan every time). With it on, a re-scan **only re-parses the
files you changed** and reuses the rest — editing a few files and looking again takes a second or two.

("Who references whom" is still recomputed wholesale, which is why it only shows on bigger projects. The output
directory gains a cache file; deleting it is harmless, it rebuilds.)

## Two small traps to avoid

- **Do not put the exe in `C:\Program Files\` (or any read-only location)** — it writes its scan output (`dist\`) and
  its config next to itself. Desktop / D: / a USB stick are all fine. It still works from a read-only folder, it just
  forgets your settings (you re-pick the project every time).
- **It only writes next to itself** (`dist\`, `launcher.config.json`) and **never modifies your code**; grouping rules
  also go to your own user directory (`%LocalAppData%\CodeAtlas\`) by default. Unless you explicitly tick "write into
  the project directory" in the wizard, the scanned project is not touched, byte for byte.
