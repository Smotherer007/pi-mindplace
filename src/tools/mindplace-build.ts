/**
 * mindplace_build tool — scan and build the knowledge graph
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { detect } from "../detect.ts";
import { extract } from "../extract.ts";
import { KnowledgeGraph } from "../graph.ts";
import { generateReport } from "../report.ts";
import { generateHtml } from "../viz.ts";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const OUT_DIR = "graph-out";

export const MindplaceBuildTool = {
  name: "mindplace_build",
  label: "Build Mind Place",
  description:
    "Scan the current project and build a knowledge graph of all code entities (functions, classes, imports). Supports JS, TS, Python, Go, Bash, JSON. The graph is persisted to graph-out/ for fast queries across sessions.",
  promptSnippet: "Build a code knowledge graph for token-efficient queries",
  parameters: Type.Object({
    path: Type.Optional(Type.String({ description: "Project root path. Defaults to cwd." })),
    force: Type.Optional(Type.Boolean({ description: "Force rebuild ignoring cache", default: false })),
    directed: Type.Optional(Type.Boolean({ description: "Build directed graph (preserve edge direction)", default: false })),
    noViz: Type.Optional(Type.Boolean({ description: "Skip HTML visualization", default: false })),
    noReport: Type.Optional(Type.Boolean({ description: "Skip GRAPH_REPORT.md", default: false })),
    update: Type.Optional(Type.Boolean({ description: "Incremental update — only re-extract changed files", default: false })),
  }),
  async execute(
    _toolCallId: string,
    params: { path?: string; force?: boolean; directed?: boolean; noViz?: boolean; noReport?: boolean; update?: boolean },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = params.path ?? ctx.cwd;
    const outFile = join(root, OUT_DIR, "graph.json");
    const graphExists = existsSync(outFile);

    if (!params.force && !params.update && graphExists) {
      return {
        content: [{ type: "text" as const, text: `Knowledge graph already exists at \`${outFile}\`. Use \`force=true\` to rebuild or \`update=true\` for incremental update.` }],
        details: { skipped: true },
      };
    }

    try {
      // Step 1: Detect
      const detected = detect(root);
      if (detected.files.length === 0) {
        const exts = Object.keys({ ".js": 1, ".ts": 1, ".py": 1, ".go": 1, ".sh": 1, ".json": 1 }).join(", ");
        return {
          content: [{ type: "text" as const, text: `No supported code files found in ${root}. Supported: ${exts}` }],
          details: { totalFiles: 0 },
        };
      }

      // Step 2: Extract with cache
      const cacheDir = join(root, OUT_DIR, "cache");
      const extResult = extract(root, detected.files, cacheDir, params.force);

      // Step 3: Build graph (merge if updating)
      let kg: KnowledgeGraph;
      if (params.update && graphExists) {
        const existing = JSON.parse(readFileSync(outFile, "utf-8"));
        kg = KnowledgeGraph.fromJSON(existing, params.directed);
        kg.merge(extResult);
      } else {
        kg = KnowledgeGraph.fromExtraction(extResult, params.directed);
      }

      // Step 4: Analyze
      kg.computeCentrality();
      kg.detectCommunities();
      const stats = kg.stats();

      // Step 5: Persist
      mkdirSync(join(root, OUT_DIR), { recursive: true });
      writeFileSync(outFile, JSON.stringify(kg.toJSON(), null, 2), "utf-8");

      let reportPath = "";
      let htmlPath = "";

      // Step 6: Report
      if (!params.noReport) {
        const report = generateReport(kg, stats, root, detected.totalFiles, detected.byExtension);
        reportPath = join(root, OUT_DIR, "GRAPH_REPORT.md");
        writeFileSync(reportPath, report, "utf-8");
      }

      // Step 7: HTML
      if (!params.noViz && stats.nodeCount <= 5000) {
        const html = generateHtml(kg, root.split("/").pop() ?? "Mind Place");
        htmlPath = join(root, OUT_DIR, "graph.html");
        writeFileSync(htmlPath, html, "utf-8");
      }

      // Build summary
      const filesLine = extResult.cached > 0
        ? `${extResult.cached} cached, ${extResult.extracted} extracted`
        : `${extResult.extracted} extracted`;

      const outputs: string[] = [
        `🧠 **Mind Place built!**`,
        ``,
        `| Metric | Value |`,
        `|--------|-------|`,
        `| Files | ${detected.totalFiles} (${filesLine}) |`,
        `| Languages | ${Object.entries(detected.byExtension).map(([e, n]) => `\`${e}\`×${n}`).join(", ") || "none"} |`,
        `| Nodes | ${stats.nodeCount} |`,
        `| Edges | ${stats.edgeCount} |`,
        `| Communities | ${stats.communityCount} |`,
        `| Mode | ${params.directed ? "directed" : "undirected"} |`,
      ];

      if (reportPath) outputs.push(`| Report | \`${OUT_DIR}/GRAPH_REPORT.md\` |`);
      if (htmlPath) outputs.push(`| Visualization | \`${OUT_DIR}/graph.html\` |`);
      outputs.push(`| Graph | \`${OUT_DIR}/graph.json\` |`);

      if (stats.godNodes.length > 0) {
        outputs.push(``);
        outputs.push(`### 🏛️ God Nodes`);
        stats.godNodes.forEach((n, i) => {
          outputs.push(`${i + 1}. **${n.label}** — ${n.degree} connections`);
        });
      }

      outputs.push(``);
      outputs.push(`Use \`mindplace_query\` to explore. Try: "What are the main modules?"`);

      return {
        content: [{ type: "text" as const, text: outputs.join("\n") }],
        details: { ...stats, cachedFiles: extResult.cached, extractedFiles: extResult.extracted },
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to build mind place: ${err instanceof Error ? err.message : String(err)}` }],
        details: { error: String(err) },
        isError: true,
      };
    }
  },
};
