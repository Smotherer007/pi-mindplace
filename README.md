# pi-mindplace

> "I walk into my mind place. The codebase is organized. Every function has its place."

Sherlock's Mind Place for your codebase. A pi extension that builds a queryable knowledge graph from your source code using tree-sitter AST parsing. Every function, class, and module becomes a node; calls, imports, and inheritance become edges. Query the graph in natural language instead of re-reading files, saving tokens on every session.

## How it works

```
  Source Code                 Knowledge Graph              Token-Efficient Queries
  +----------+               +----------------+           +---------------------+
  | auth.ts  |--+            |  authenticate   |           | "How does auth      |
  | ctrl.ts  |--| tree-sitter|    +-calls->    |--query-->|  flow work?"        |
  | util.ts  |--+  AST       |  validate <-----|           | -> 3 nodes, 847 tok  |
  +----------+               |  hashPassword   |           +---------------------+
                             +----------------+
                               graph-out/
                               +-- graph.json   (persisted across sessions)
```

1. **`mindplace_build`** parses your source files locally with tree-sitter (zero LLM cost), extracting functions, classes, imports, and call relationships into a knowledge graph
2. **`mindplace_query`** uses TF-IDF scoring and BFS traversal to find the most relevant subgraph within your token budget
3. **`mindplace_explain`** drills into a single entity and shows all its connections

### Token savings mechanism

When `graph-out/graph.json` exists, the extension injects graph-first instructions into pi's system prompt. The agent follows a 3-layer query rule:

1. First: use `mindplace_query` to understand code structure (cheap subgraph)
2. Second: use `mindplace_explain` for specific entities
3. Third: only read raw files when editing or when the graph doesn't have the answer

This mirrors graphify's PreToolUse hook but adapted to pi's extension model via `before_agent_start`. The graph is built once (one-time token cost) and every subsequent codebase question is answered from the graph instead of re-reading files.

## Supported languages

- JavaScript (.js, .mjs, .cjs, .jsx)
- TypeScript (.ts, .mts, .cts, .tsx)
- Python (.py, .pyi)
- Go (.go)
- Bash (.sh, .bash, .zsh)
- JSON (.json)

## Install

```bash
pi install npm:@patimweb/pi-mindplace
```

Or for local development:

```bash
pi -e /path/to/pi-mindplace/index.ts
```

Requirements: Node.js 26+, tree-sitter (auto-installed as dependency).

## Usage

### Build the mind place

```
mindplace_build
```

Scans all supported files in the current directory and creates `graph-out/` with:

| File | Description |
|------|-------------|
| `graph.json` | The full knowledge graph, queryable across sessions |
| `GRAPH_REPORT.md` | Audit report with god nodes, communities, suggested questions |
| `graph.html` | Interactive D3.js visualization (open in browser) |
| `cache/` | SHA256 cache for incremental rebuilds |

Options:

```
mindplace_build path="./src"              # scan specific directory
mindplace_build force=true                # force rebuild ignoring cache
mindplace_build update=true               # incremental: only re-extract changed files
mindplace_build directed=true             # preserve edge direction
mindplace_build noViz=true                # skip HTML visualization
mindplace_build noReport=true             # skip report generation
```

### Query the graph

```
mindplace_query question="How does authentication flow work?" budget=4000
```

Returns a scoped subgraph of relevant nodes and their relationships, formatted as markdown.

### Explain a node

```
mindplace_explain name="authenticateUser"
```

Shows detailed info about a specific entity: where it's defined, what it connects to, and what calls it.

### Command shortcuts

The `/mindplace` command provides quick access:

```
/mindplace              # show status
/mindplace "auth flow"  # query shortcut
/mindplace build        # rebuild
```

## Architecture

```
pi-mindplace/
+-- index.ts                  Extension entry point + token savings hooks
+-- src/
|   +-- types.ts              Core data interfaces and language support map
|   +-- detect.ts             File scanner and language detection
|   +-- extract.ts            tree-sitter AST extraction with SHA256 caching
|   +-- graph.ts              KnowledgeGraph class (PageRank, Louvain, directed mode)
|   +-- query.ts              TF-IDF scorer + BFS/DFS traversal with token budget
|   +-- report.ts             GRAPH_REPORT.md generator
|   +-- viz.ts                D3.js standalone graph.html generator
|   +-- tools/
|       +-- mindplace-build.ts
|       +-- mindplace-query.ts
|       +-- mindplace-explain.ts
+-- tests/
    +-- detect.test.ts
    +-- extract.test.ts
    +-- graph.test.ts
    +-- query.test.ts
    +-- fixtures/
```

## Design decisions

- Zero Python: pure TypeScript/Node.js, no Python required
- Zero LLM cost for building: tree-sitter AST parsing is deterministic and local
- Minimal dependencies: only `tree-sitter` and language grammars. No numpy, no scikit-learn, no networkx
- PageRank without numpy: pure JS power iteration in ~25 lines
- TF-IDF without scikit-learn: hand-rolled with smoothed IDF and camelCase/snake_case tokenization plus substring matching
- Louvain without networkx: greedy modularity optimization in ~50 lines
- Token-budget-aware: BFS traversal that stops when the budget is exhausted
- Incremental builds: SHA256 content hashing, unchanged files skip re-extraction
- Standalone visualization: D3.js graph.html with search, community coloring, and drag interaction

## License

MIT
