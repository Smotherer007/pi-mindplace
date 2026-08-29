/**
 * AST extraction using tree-sitter with SHA256 caching.
 *
 * Supports: JavaScript, TypeScript, Python, Go, Bash, JSON, C#
 * Each file is hashed — unchanged files skip re-extraction.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import Parser from "tree-sitter";

import type { ExtractionResult, GraphEdge, GraphNode } from "./types.ts";
import { CODE_EXTENSIONS } from "./types.ts";

const parser = new Parser();

// ── Lazy + self-building grammar loading ────────────────────────────────────
//
// Tree-sitter grammar packages ship native `.node` addons resolved via
// `node-gyp-build`. Some grammars do not publish a prebuilt binary for every
// platform/Node ABI (e.g. tree-sitter-kotlin has no linux-x64 prebuild for
// Node 26 / ABI 147), so importing one at module scope would crash the whole
// extension on install. On top of that, npm v12 blocks install scripts by
// default (the `allowScripts` allowlist is governed by the *root* project, which
// pi controls), so a `postinstall` in this package would never run. Therefore:
//   - We load each grammar lazily.
//   - If the native addon is missing, we compile it from source on demand with
//     node-gyp (the same thing the package's install script would have done).
//   - If the build can't run (no compiler / no node-gyp / timeout), we degrade
//     gracefully: skip only that language, keep everything else working.
const _require = createRequire(import.meta.url);

interface GrammarSpec {
  /** CJS module path that resolves to the grammar binding */
  module: string;
  /** File extensions this grammar can parse */
  exts: string[];
}

const GRAMMAR_SPECS: GrammarSpec[] = [
  { module: "tree-sitter-javascript", exts: [".js", ".mjs", ".cjs"] },
  { module: "tree-sitter-typescript/bindings/node/typescript.js", exts: [".ts", ".mts", ".cts"] },
  { module: "tree-sitter-typescript/bindings/node/tsx.js", exts: [".tsx", ".jsx"] },
  { module: "tree-sitter-python", exts: [".py", ".pyi"] },
  { module: "tree-sitter-go", exts: [".go"] },
  { module: "tree-sitter-bash", exts: [".sh", ".bash", ".zsh"] },
  { module: "tree-sitter-json", exts: [".json"] },
  { module: "tree-sitter-java", exts: [".java"] },
  { module: "tree-sitter-rust", exts: [".rs"] },
  { module: "tree-sitter-cpp", exts: [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"] },
  { module: "tree-sitter-c-sharp", exts: [".cs"] },
  { module: "tree-sitter-ruby", exts: [".rb"] },
  { module: "tree-sitter-kotlin", exts: [".kt", ".kts"] },
  { module: "tree-sitter-scala", exts: [".scala", ".sc"] },
];

interface LoadedGrammar {
  grammar: Parser.Language;
  exts: Set<string>;
}

const grammarCache = new Map<string, LoadedGrammar | null>();
const grammarWarned = new Set<string>();

/** Time budget (ms) for a single from-source grammar build. */
const BUILD_TIMEOUT_MS = 180_000;

let nodeGypBinCache: string | null | undefined;
/**
 * Locate node-gyp, which npm bundles for every platform (Windows/Linux/macOS),
 * so we can compile a grammar from source when no prebuilt binary exists.
 */
function getNodeGypBin(): string | null {
  if (nodeGypBinCache !== undefined) return nodeGypBinCache;
  nodeGypBinCache = null;

  // 1. node-gyp is already in the module resolution path
  try {
    const pkgJson = _require.resolve("node-gyp/package.json");
    const pkg = _require(pkgJson) as { bin?: string | Record<string, string> };
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["node-gyp"];
    if (bin) {
      nodeGypBinCache = join(dirname(pkgJson), bin);
      return nodeGypBinCache;
    }
  } catch {
    /* not in module tree */
  }

  // 2. npm's bundled node-gyp (npm resolves it on every platform)
  try {
    const res = spawnSync("npm", ["root", "-g"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    if (res.status === 0) {
      const npmRoot = (res.stdout || "").trim();
      for (const cand of [
        join(npmRoot, "npm", "node_modules", "node-gyp", "bin", "node-gyp.js"),
        join(npmRoot, "node-gyp", "bin", "node-gyp.js"),
      ]) {
        if (existsSync(cand)) {
          nodeGypBinCache = cand;
          return cand;
        }
      }
    }
  } catch {
    /* npm unavailable */
  }

  return null;
}

/** Resolve the package directory (the dir containing `package.json`) for a grammar spec. */
function grammarPackageDir(spec: GrammarSpec): string | null {
  const pkgName = spec.module.split("/")[0];
  try {
    return dirname(_require.resolve(`${pkgName}/package.json`));
  } catch {
    return null;
  }
}

/**
 * Compile a grammar's native addon from source via `node-gyp rebuild` (the same
 * thing the package's `install` script would have run). Cross-platform: node-gyp
 * uses MSVC on Windows and gcc/clang on Linux/macOS.
 */
function buildGrammar(spec: GrammarSpec): boolean {
  const pkgDir = grammarPackageDir(spec);
  const nodeGyp = getNodeGypBin();
  if (!pkgDir || !nodeGyp) return false;

  try {
    const res = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
      cwd: pkgDir,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: BUILD_TIMEOUT_MS,
      windowsHide: true,
    });
    return res.status === 0;
  } catch {
    return false;
  }
}

/**
 * Synchronously load a grammar via the CJS binding. If the native addon is
 * missing (no prebuild for this platform/ABI, and npm v12 blocks install
 * scripts so nothing was built), try to compile it from source. If that fails
 * too (no compiler / no node-gyp / build timeout), degrade gracefully: warn
 * once and skip just this language instead of failing the whole extension.
 */
function loadGrammar(spec: GrammarSpec): LoadedGrammar | null {
  const key = spec.module;
  if (grammarCache.has(key)) return grammarCache.get(key) ?? null;

  const tryLoad = (): LoadedGrammar | null => {
    try {
      const grammar = _require(spec.module) as unknown as Parser.Language;
      const loaded: LoadedGrammar = { grammar, exts: new Set(spec.exts) };
      return loaded;
    } catch {
      return null;
    }
  };

  let loaded = tryLoad();
  if (!loaded && buildGrammar(spec)) loaded = tryLoad();

  if (loaded) {
    grammarCache.set(key, loaded);
    return loaded;
  }

  grammarCache.set(key, null);
  if (!grammarWarned.has(key)) {
    grammarWarned.add(key);
    console.warn(
      `[pi-mindplace] Grammar "${spec.module}" unavailable — no native build found and a from-source build failed. ` +
        `Files with extension(s) ${spec.exts.join(", ")} will be skipped.`,
    );
  }
  return null;
}

// ── SHA256 Cache ──────────────────────────────────────────────────────────────

function fileHash(absPath: string): string {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex").slice(0, 16);
}

interface CacheEntry {
  hash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

function loadCache(cacheDir: string): Map<string, CacheEntry> {
  const cache = new Map<string, CacheEntry>();
  const cacheFile = join(cacheDir, "cache.json");
  if (!existsSync(cacheFile)) return cache;
  try {
    const data = JSON.parse(readFileSync(cacheFile, "utf-8"));
    for (const [file, entry] of Object.entries(data) as [string, CacheEntry][]) {
      cache.set(file, entry);
    }
  } catch { /* ignore corrupt cache */ }
  return cache;
}

function saveCache(cacheDir: string, cache: Map<string, CacheEntry>): void {
  mkdirSync(cacheDir, { recursive: true });
  const obj: Record<string, CacheEntry> = {};
  for (const [k, v] of cache) obj[k] = v;
  writeFileSync(join(cacheDir, "cache.json"), JSON.stringify(obj, null, 2), "utf-8");
}

// ── Node ID helpers ───────────────────────────────────────────────────────────

function nodeId(file: string, name: string): string {
  const clean = file.replace(/[\\/]/g, "_").replace(/\.[^.]+$/, "");
  const safeName = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return `${clean}_${safeName}`;
}

function pickGrammar(file: string): Parser.Language | null {
  const ext = file.includes(".") ? file.slice(file.lastIndexOf(".")) : "";
  for (const spec of GRAMMAR_SPECS) {
    if (spec.exts.includes(ext)) return loadGrammar(spec)?.grammar ?? null;
  }
  return null;
}

// ── JS/TS Extraction ──────────────────────────────────────────────────────────

function extractJS_TS(filePath: string, source: string, root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();

  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    const loc = `L${node.startPosition.row + 1}`;
    let description: string | undefined;
    const prev = node.previousNamedSibling;
    if (prev?.type === "comment" && (prev.text.startsWith("/**") || prev.text.startsWith("///"))) {
      description = prev.text.replace(/^\/\*\*\s*/, "").replace(/^\/\/[!/]\s*/, "")
        .replace(/\s*\*\/$/, "").replace(/\n\s*\*\s?/g, " ")
        .replace(/\s+/g, " ").trim().slice(0, 200);
    }
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: loc, description });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_declaration" || t === "generator_function_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? node.descendantsOfType("identifier")[0]?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call_expression")) {
        const callee = call.childForFieldName?.("function");
        if (callee) {
          edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
        }
      }
      return;
    }

    if (t === "class_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? node.descendantsOfType("identifier")[0]?.text ?? "AnonymousClass";
      const id = addNode(name, "class", node);
      for (const hc of node.children) {
        if (hc.type === "class_heritage") {
          for (const cls of hc.descendantsOfType("identifier")) {
            edges.push({ source: id, target: nodeId(filePath, cls.text), relation: "inherits", confidence: "EXTRACTED" });
          }
        }
      }
      for (const body of node.children) {
        if (body.type === "class_body") {
          for (const mem of body.children) {
            if (mem.type === "method_definition" || mem.type === "public_field_definition") {
              const mn = mem.childForFieldName?.("name")?.text ?? "unknown";
              const mid = addNode(`${name}.${mn}`, "method", mem);
              edges.push({ source: id, target: mid, relation: "contains", confidence: "EXTRACTED" });
            }
          }
        }
      }
      return;
    }

    if (t === "variable_declaration") {
      for (const ch of node.children) {
        if (ch.type === "variable_declarator") {
          const vn = ch.childForFieldName?.("name")?.text;
          const val = ch.childForFieldName?.("value");
          if (vn && val && (val.type === "arrow_function" || val.type === "function_expression")) {
            addNode(vn, "function", node);
          } else if (vn && (node.parent?.type === "export_statement" || node.parent?.type === "program")) {
            addNode(vn, "variable", node);
          }
        }
      }
      return;
    }

    if (t === "interface_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousInterface";
      addNode(name, "interface", node);
      return;
    }

    if (t === "type_alias_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousType";
      addNode(name, "type", node);
      return;
    }

    if (t === "import_statement") {
      const spec = node.childForFieldName?.("source");
      if (spec) {
        const modPath = spec.text.replace(/^["']|["']$/g, "");
        if (modPath.startsWith(".")) {
          const targetFile = resolveModulePath(filePath, modPath, root);
          if (targetFile) {
            const tgtId = nodeId(targetFile, "file");
            edges.push({ source: fileNodeId, target: tgtId, relation: "imports", confidence: "EXTRACTED" });
            const clause = node.childForFieldName?.("import_clause");
            if (clause) {
              for (const ispec of clause.descendantsOfType("import_specifier")) {
                const iname = ispec.childForFieldName?.("name")?.text;
                if (iname) edges.push({ source: fileNodeId, target: nodeId(targetFile, iname), relation: "imports", confidence: "INFERRED", confidenceScore: 0.95 });
              }
            }
          }
        }
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Python Extraction ─────────────────────────────────────────────────────────

function extractPython(filePath: string, source: string, _root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    const loc = `L${node.startPosition.row + 1}`;
    // Extract docstring
    let desc: string | undefined;
    const body = node.childForFieldName?.("body");
    if (body && body.firstChild?.type === "expression_statement") {
      const es = body.firstChild.firstChild;
      if (es?.type === "string" && (es.text.startsWith('"""') || es.text.startsWith("'''"))) {
        desc = es.text.replace(/^["']{3}|["']{3}$/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
      }
    }
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: loc, description: desc });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_definition") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call")) {
        const callee = call.childForFieldName?.("function");
        let callName: string | null = null;
        if (callee) {
          if (callee.type === "attribute") {
            callName = callee.text;
          } else {
            callName = callee.text;
          }
        }
        if (callName) {
          edges.push({ source: id, target: nodeId(filePath, callName), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
        }
      }
      return;
    }

    if (t === "class_definition") {
      const name = node.childForFieldName?.("name")?.text ?? "AnonymousClass";
      const id = addNode(name, "class", node);
      // Inheritance
      for (const base of node.children) {
        if (base.type === "argument_list") {
          for (const arg of base.descendantsOfType("identifier")) {
            edges.push({ source: id, target: nodeId(filePath, arg.text), relation: "inherits", confidence: "EXTRACTED" });
          }
        }
      }
      return;
    }

    // Decorated functions/classes
    if (t === "decorated_definition") {
      const def = node.childForFieldName?.("definition");
      if (def) {
        const defType = def.type;
        if (defType === "function_definition") {
          const name = def.childForFieldName?.("name")?.text ?? "anonymous";
          const id = addNode(name, "function", node);
          const decorator = node.firstChild;
          if (decorator?.type === "decorator") {
            const decName = decorator.childForFieldName?.("name")?.text;
            if (decName) edges.push({ source: id, target: nodeId(filePath, decName), relation: "references", confidence: "EXTRACTED" });
          }
          return;
        }
        if (defType === "class_definition") {
          const name = def.childForFieldName?.("name")?.text ?? "AnonymousClass";
          addNode(name, "class", node);
          return;
        }
      }
    }

    if (t === "import_statement" || t === "import_from_statement") {
      const mod = node.childForFieldName?.("name") ?? node.childForFieldName?.("module_name");
      if (mod) {
        const modName = mod.text;
        // Add import edge (could be external, but still track it)
        edges.push({ source: fileNodeId, target: nodeId(filePath, modName), relation: "imports", confidence: "EXTRACTED" });
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Go Extraction ─────────────────────────────────────────────────────────────

function extractGo(filePath: string, source: string, _root: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: `L${node.startPosition.row + 1}` });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(node: Parser.SyntaxNode): void {
    const t = node.type;

    if (t === "function_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const id = addNode(name, "function", node);
      for (const call of node.descendantsOfType("call_expression")) {
        const callee = call.childForFieldName?.("function");
        if (callee) edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
      }
      return;
    }

    if (t === "type_declaration") {
      for (const spec of node.descendantsOfType("type_spec")) {
        const name = spec.childForFieldName?.("name")?.text;
        if (name) addNode(name, spec.children.some(c => c.type === "struct_type") ? "struct" : "type", spec);
      }
      return;
    }

    if (t === "method_declaration") {
      const name = node.childForFieldName?.("name")?.text ?? "anonymous";
      const receiver = node.childForFieldName?.("receiver");
      if (receiver) {
        const recvType = receiver.descendantsOfType("type_identifier")[0]?.text ?? "";
        addNode(`${recvType}.${name}`, "method", node);
      } else {
        addNode(name, "method", node);
      }
      return;
    }

    if (t === "import_declaration") {
      for (const spec of node.descendantsOfType("import_spec")) {
        const pkg = spec.childForFieldName?.("name")?.text;
        if (pkg) edges.push({ source: fileNodeId, target: nodeId(filePath, pkg), relation: "imports", confidence: "EXTRACTED" });
      }
      return;
    }

    for (const child of node.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── Bash Extraction ───────────────────────────────────────────────────────────

function extractBash(filePath: string, _source: string, _root: string): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);
  // Basic function detection via regex fallback (tree-sitter-bash grammar can be finicky)
  // For now: extract function names from the full source
  const funcRe = /^(?:function\s+)?(\w+)\s*\(\s*\)/gm;
  let match: RegExpExecArray | null;
  while ((match = funcRe.exec(_source)) !== null) {
    const name = match[1];
    const line = _source.slice(0, match.index).split("\n").length;
    const id = nodeId(filePath, name);
    if (!seenIds.has(id)) {
      seenIds.add(id);
      nodes.push({ id, label: name, type: "function", sourceFile: filePath, sourceLocation: `L${line}` });
      edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    }
  }
  return { nodes, edges };
}

// ── JSON Extraction ───────────────────────────────────────────────────────────

function extractJson(filePath: string, source: string, _root: string): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  // Add top-level keys as nodes (useful for package.json, tsconfig, etc.)
  try {
    const obj = JSON.parse(source);
    if (typeof obj === "object" && obj !== null && !Array.isArray(obj)) {
      for (const key of Object.keys(obj).slice(0, 20)) {
        const id = nodeId(filePath, key);
        nodes.push({ id, label: key, type: "field", sourceFile: filePath });
        edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
      }
    }
  } catch { /* not valid JSON, skip */ }
  return { nodes, edges };
}

// ── Generic extractor (Java, C++, Rust, Ruby, Kotlin, Scala) ───────────────

/** Node types that represent named definitions across languages */
const CALL_EXPR_TYPES = new Set(["call_expression", "method_invocation", "call"]);

function extractGeneric(filePath: string, source: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenIds.add(fileNodeId);

  function addNode(name: string, type: string, node: Parser.SyntaxNode): string {
    const id = nodeId(filePath, name);
    if (seenIds.has(id)) return id;
    seenIds.add(id);
    nodes.push({ id, label: name, type, sourceFile: filePath, sourceLocation: `L${node.startPosition.row + 1}` });
    edges.push({ source: fileNodeId, target: id, relation: "contains", confidence: "EXTRACTED" });
    return id;
  }

  function walk(n: Parser.SyntaxNode): void {
    const t = n.type;

    // Named function/method
    if (t === "function_declaration" || t === "method_declaration" || t === "function_definition" || t === "constructor_declaration") {
      const name = n.childForFieldName?.("name")?.text ?? n.descendantsOfType("identifier")[0]?.text ?? "anonymous";
      const id = addNode(name, "function", n);
      // Find call expressions within this function
      for (const ct of CALL_EXPR_TYPES) {
        for (const call of n.descendantsOfType(ct)) {
          const callee = call.firstChild;
          if (callee && callee.type !== "(" && callee.type !== "{") {
            edges.push({ source: id, target: nodeId(filePath, callee.text), relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 });
          }
        }
      }
      // Continue walking to find nested declarations
    }

    // Class / struct / interface / trait / object / enum
    else if (t === "class_declaration" || t === "class_definition" || t === "struct_item" ||
        t === "interface_declaration" || t === "trait_item" || t === "object_definition" ||
        t === "enum_item" || t === "enum_declaration") {
      const name = n.childForFieldName?.("name")?.text ?? n.firstChild?.text ?? "Anonymous";
      const kind = t.includes("interface") ? "interface" : t.includes("struct") ? "struct" :
                   t.includes("enum") ? "enum" : t.includes("trait") ? "trait" :
                   t.includes("object") ? "object" : "class";
      const id = addNode(name, kind, n);

      // Inheritance / extends / implements / superclass
      const INHERIT_TYPES = new Set(["superclass", "super_interfaces", "base_class_clause",
        "trait_bounds", "template", "extends_clause", "implements_clause"]);
      for (const child of n.children) {
        if (INHERIT_TYPES.has(child.type) || child.type.includes("heritage")) {
          const ID_TYPES = ["identifier", "type_identifier", "scoped_identifier", "scoped_type_identifier", "generic_type"];
          for (const idt of ID_TYPES) {
            for (const ref of child.descendantsOfType(idt)) {
              edges.push({ source: id, target: nodeId(filePath, ref.text), relation: "inherits", confidence: "EXTRACTED" });
            }
          }
        }
      }
      // Continue walking to find nested methods/classes
    }

    // Import/use/mod declarations
    else if (t === "use_declaration" || t === "import_declaration" || t === "mod_item") {
      const ID_TYPES = ["identifier", "scoped_identifier", "scoped_type_identifier"];
      for (const idt of ID_TYPES) {
        for (const nameNode of n.descendantsOfType(idt)) {
          const txt = nameNode.text;
          if (txt !== "use" && txt !== "import" && txt !== "mod" && txt !== "pub" && txt !== "crate") {
            edges.push({ source: fileNodeId, target: nodeId(filePath, txt), relation: "imports", confidence: "EXTRACTED" });
          }
        }
      }
      return;
    }

    for (const child of n.children) walk(child);
  }

  walk(tree.rootNode);
  return { nodes, edges };
}

// ── C# extraction ───────────────────────────────────────────────────────────

function extractCSharp(filePath: string, tree: Parser.Tree): ExtractionResult {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seenNodeIds = new Set<string>();
  const seenEdgeIds = new Set<string>();
  const fileNodeId = nodeId(filePath, "file");
  nodes.push({ id: fileNodeId, label: filePath, type: "file", sourceFile: filePath });
  seenNodeIds.add(fileNodeId);

  function addEdge(
    source: string,
    target: string,
    relation: GraphEdge["relation"],
    confidence: GraphEdge["confidence"],
  ): void {
    const edgeId = `${source}:${relation}:${target}`;
    if (seenEdgeIds.has(edgeId)) return;
    seenEdgeIds.add(edgeId);
    edges.push({ source, target, relation, confidence });
  }

  function addNode(
    name: string,
    type: string,
    node: Parser.SyntaxNode,
    parentId: string,
  ): string {
    const id = nodeId(filePath, name);
    if (!seenNodeIds.has(id)) {
      seenNodeIds.add(id);
      nodes.push({
        id,
        label: name,
        type,
        sourceFile: filePath,
        sourceLocation: `L${node.startPosition.row + 1}`,
      });
    }
    addEdge(parentId, id, "contains", "EXTRACTED");
    return id;
  }

  function declarationName(node: Parser.SyntaxNode): string {
    return (
      node.childForFieldName?.("name")?.text ??
      node.descendantsOfType("identifier")[0]?.text ??
      "anonymous"
    );
  }

  function addBaseTypes(node: Parser.SyntaxNode, ownerId: string): void {
    const baseList =
      node.childForFieldName?.("base_list") ??
      node.children.find((child) => child.type === "base_list");
    if (!baseList) return;
    for (const typeNode of baseList.namedChildren) {
      if (
        typeNode.type === "identifier" ||
        typeNode.type === "qualified_name" ||
        typeNode.type === "generic_name"
      ) {
        addEdge(ownerId, nodeId(filePath, typeNode.text), "inherits", "EXTRACTED");
      }
    }
  }

  function addCalls(node: Parser.SyntaxNode, ownerId: string): void {
    for (const invocation of node.descendantsOfType("invocation_expression")) {
      const target = invocation.childForFieldName?.("function")?.text;
      if (target) addEdge(ownerId, nodeId(filePath, target), "calls", "INFERRED");
    }
  }

  function walk(node: Parser.SyntaxNode, parentId: string, scope: string): void {
    if (node.type === "compilation_unit") {
      let activeParentId = parentId;
      let activeScope = scope;
      for (const child of node.namedChildren) {
        if (child.type === "file_scoped_namespace_declaration") {
          const namespaceName =
            child.childForFieldName?.("name")?.text ?? declarationName(child);
          activeParentId = addNode(namespaceName, "namespace", child, parentId);
          activeScope = namespaceName;
          continue;
        }
        walk(child, activeParentId, activeScope);
      }
      return;
    }

    const type = node.type;
    const named = declarationName(node);
    const qualifiedName = scope ? `${scope}.${named}` : named;

    if (type === "namespace_declaration") {
      const namespaceName = node.childForFieldName?.("name")?.text ?? named;
      const namespaceId = addNode(namespaceName, "namespace", node, parentId);
      for (const child of node.namedChildren) walk(child, namespaceId, namespaceName);
      return;
    }

    if (type === "using_directive") {
      const importedName =
        node.childForFieldName?.("name")?.text ?? node.namedChildren[0]?.text;
      if (importedName)
        addEdge(fileNodeId, nodeId(filePath, importedName), "imports", "EXTRACTED");
      return;
    }

    if (type === "attribute") {
      const attributeName = node.childForFieldName?.("name")?.text ?? named;
      addNode(
        `${scope}.${attributeName}@L${node.startPosition.row + 1}`,
        "attribute",
        node,
        parentId,
      );
      return;
    }

    if (type === "global_statement") {
      const statementId = addNode(
        `top-level@L${node.startPosition.row + 1}`,
        "top-level-statement",
        node,
        parentId,
      );
      addCalls(node, statementId);
      return;
    }

    const declarationTypes: Record<string, string> = {
      class_declaration: "class",
      struct_declaration: "struct",
      interface_declaration: "interface",
      enum_declaration: "enum",
      record_declaration: "record",
      delegate_declaration: "delegate",
    };
    const declarationKind = declarationTypes[type];
    if (declarationKind) {
      const declarationId = addNode(qualifiedName, declarationKind, node, parentId);
      addBaseTypes(node, declarationId);
      for (const child of node.namedChildren) walk(child, declarationId, qualifiedName);
      return;
    }

    const memberTypes: Record<string, string> = {
      method_declaration: "method",
      constructor_declaration: "constructor",
      property_declaration: "property",
      event_declaration: "event",
      event_field_declaration: "event",
      field_declaration: "field",
    };
    const memberKind = memberTypes[type];
    if (memberKind) {
      const memberName =
        type === "event_field_declaration"
          ? (node.descendantsOfType("variable_declarator")[0]?.childForFieldName?.("name")
              ?.text ?? named)
          : named;
      const memberId = addNode(`${scope}.${memberName}`, memberKind, node, parentId);
      addCalls(node, memberId);
      return;
    }

    for (const child of node.namedChildren) walk(child, parentId, scope);
  }

  walk(tree.rootNode, fileNodeId, "");
  return { nodes, edges };
}

// ── Dispatch ──────────────────────────────────────────────────────────────────

function extractFile(filePath: string, root: string): ExtractionResult {
  const absPath = resolve(root, filePath);
  const grammar = pickGrammar(filePath);
  if (!grammar) return { nodes: [], edges: [] };

  // Skip files larger than 1MB (e.g. package-lock.json, large data files)
  try {
    const stats = statSync(absPath);
    if (stats.size > 1_000_000) return { nodes: [], edges: [] };
  } catch {
    return { nodes: [], edges: [] };
  }

  const source = readFileSync(absPath, "utf-8");

  let tree: Parser.Tree;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(source);
  } catch {
    // Tree-sitter parse error (corrupt file, unsupported syntax, etc.)
    return { nodes: [], edges: [] };
  }

  const lang = CODE_EXTENSIONS[filePath.slice(filePath.lastIndexOf("."))] ?? "unknown";

  switch (lang) {
    case "javascript":
    case "typescript":
    case "tsx":
      return extractJS_TS(filePath, source, root, tree);
    case "python":
      return extractPython(filePath, source, root, tree);
    case "go":
      return extractGo(filePath, source, root, tree);
    case "bash":
      return extractBash(filePath, source, root);
    case "json":
      return extractJson(filePath, source, root);
    case "csharp":
      return extractCSharp(filePath, tree);
    case "java":
    case "rust":
    case "cpp":
    case "ruby":
    case "kotlin":
    case "scala":
      return extractGeneric(filePath, source, tree);
    default:
      return { nodes: [], edges: [] };
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve a relative module path to an actual file.
 * @param fromFile The importing file (relative to root)
 * @param modPath The import path (e.g. "./auth")
 * @param root Project root for absolute file existence checks
 */
function resolveModulePath(fromFile: string, modPath: string, root: string): string | null {
  if (!modPath.startsWith(".")) return null;

  // Normalize the base directory of the importing file
  const fromDir = fromFile.includes("/") ? fromFile.slice(0, fromFile.lastIndexOf("/")) : ".";
  // Join and clean: "src" + "./auth.ts" → "src/auth.ts"
  let resolved = fromDir === "." ? modPath.replace(/^\.\//, "") : `${fromDir}/${modPath.replace(/^\.\//, "")}`;
  // Normalize
  resolved = resolved.replace(/\/\.\//g, "/");

  // If the path already has a known extension, check directly
  const hasExt = /\.(ts|tsx|js|jsx|mts|mjs|py|go)$/.test(resolved);
  if (hasExt && existsSync(join(root, resolved))) return resolved;

  // Try known extensions
  const exts = [".ts", ".js", ".tsx", ".jsx", ".mts", ".mjs", ".py", ".go"];
  for (const ext of exts) {
    if (existsSync(join(root, resolved + ext))) return resolved + ext;
  }
  for (const ext of exts) {
    if (existsSync(join(root, `${resolved}/index${ext}`))) return `${resolved}/index${ext}`;
  }
  return null;
}

/**
 * Extract entities from code files with caching.
 * @param root Project root
 * @param files Relative file paths
 * @param cacheDir Cache directory (null = no cache)
 * @param force Ignore cache
 */
export function extract(
  root: string,
  files: string[],
  cacheDir?: string,
  force?: boolean,
  onProgress?: (done: number) => void,
): ExtractionResult & { cached: number; extracted: number } {
  const cache = cacheDir ? loadCache(cacheDir) : new Map<string, CacheEntry>();
  const allNodes: GraphNode[] = [];
  const allEdges: GraphEdge[] = [];
  const seenIds = new Set<string>();
  let cached = 0;
  let extracted = 0;

  for (const file of files) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) continue;

    const hash = fileHash(abs);

    if (!force && cache.has(file) && cache.get(file)!.hash === hash) {
      const entry = cache.get(file)!;
      for (const n of entry.nodes) {
        if (!seenIds.has(n.id)) { seenIds.add(n.id); allNodes.push(n); }
      }
      allEdges.push(...entry.edges);
      cached++;
      continue;
    }

    const result = extractFile(file, root);
    for (const n of result.nodes) {
      if (!seenIds.has(n.id)) { seenIds.add(n.id); allNodes.push(n); }
    }
    allEdges.push(...result.edges);
    cache.set(file, { hash, nodes: result.nodes, edges: result.edges });
    extracted++;
    onProgress?.(cached + extracted);
  }

  if (cacheDir) saveCache(cacheDir, cache);

  return { nodes: allNodes, edges: allEdges, cached, extracted };
}
