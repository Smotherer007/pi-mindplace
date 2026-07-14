/**
 * pi-mindplace — Knowledge Graph Extension for pi
 *
 * Sherlock's Mind Place for your codebase. Builds a queryable knowledge graph
 * from your source code using tree-sitter AST parsing.
 *
 * KEY TOKEN SAVINGS MECHANISM:
 *   When graph-out/graph.json exists, we inject system prompt instructions
 *   that tell the agent to use mindplace_query BEFORE reading source files.
 *   This mirrors graphify's PreToolUse hook but adapted to pi's extension model:
 *   - before_agent_start: inject graph-first instructions + always-on file map + staleness check
 *   - tool_result: annotate query results with source location hints
 *
 * Tools:
 *   - mindplace_build: Scan project and build the knowledge graph
 *   - mindplace_query: Query the graph with a natural-language question
 *   - mindplace_explain: Get details about a specific entity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { MindplaceBuildTool } from "./src/tools/mindplace-build.ts";
import { MindplaceQueryTool } from "./src/tools/mindplace-query.ts";
import { MindplaceExplainTool } from "./src/tools/mindplace-explain.ts";
import { detect } from "./src/detect.ts";
import { KnowledgeGraph } from "./src/graph.ts";

const OUT_DIR = "graph-out";
const GRAPH_FILE = "graph.json";

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, GRAPH_FILE);
}

function checkStaleness(cwd: string): { stale: boolean; count: number } {
  const gp = graphPath(cwd);
  if (!existsSync(gp)) return { stale: false, count: 0 };

  const graphMtime = statSync(gp).mtimeMs;
  let newerCount = 0;

  try {
    const detected = detect(cwd);
    for (const file of detected.files.slice(0, 200)) {
      try {
        const fmtime = statSync(join(cwd, file)).mtimeMs;
        if (fmtime > graphMtime) newerCount++;
      } catch { /* file gone, ignore */ }
    }
  } catch { /* detection failed, assume OK */ }

  return { stale: newerCount > 0, count: newerCount };
}

/**
 * Build a compact file-level context string from the knowledge graph.
 * Uses file-level PageRank to rank files by importance, then lists
 * each file with its top symbols. Fits within a token budget (~1500 tokens).
 */
function buildFileContext(cwd: string): string {
  const gp = graphPath(cwd);
  if (!existsSync(gp)) return "";

  try {
    const raw = JSON.parse(readFileSync(gp, "utf-8"));
    const kg = KnowledgeGraph.fromJSON(raw);

    const ranked = kg.fileRanking(50);
    if (ranked.length === 0) return "";

    // Filter: skip test/fixture/config files, only real source
    const skipPatterns = [/^tests?\//, /^__tests__\//, /\.test\./, /\.spec\./, /fixtures/,
      /node_modules/, /package\.json/, /tsconfig/, /\.config\./];

    const lines: string[] = [];
    lines.push("## Repository Map (top files by importance)");
    lines.push("");
    lines.push("These are the most architecturally significant source files.");
    lines.push("You see this map on every request — use it to orient yourself");
    lines.push("before reading individual files.");
    lines.push("");

    let tokens = 0;
    const CHARS_PER_TOKEN = 4;

    for (const entry of ranked) {
      if (skipPatterns.some(p => p.test(entry.file))) continue;

      const symbols = entry.symbols.length > 0
        ? ` — ${entry.symbols.map(s => s.label).join(", ")}`
        : "";
      const line = `${entry.file}${symbols}`;
      const lineTokens = Math.ceil(line.length / CHARS_PER_TOKEN);

      if (tokens + lineTokens > 1500) break;

      lines.push(line);
      tokens += lineTokens;
    }

    return lines.join("\n");
  } catch {
    return "";
  }
}

const GRAPH_FIRST_INSTRUCTIONS = `
## Mind Place Knowledge Graph

A knowledge graph of this codebase exists at \`${OUT_DIR}/${GRAPH_FILE}\`.
You MUST follow this 3-layer query rule:

1. FIRST: Use \`mindplace_query\` to understand code structure, relationships between
   entities, or trace how data flows through the codebase. This gives you a scoped
   subgraph at a fraction of the tokens.
2. SECOND: Use \`mindplace_explain\` to drill into specific entities and see all
   their connections.
3. THIRD (last resort): Only read raw source files with \`read\` when you need to
   see the exact implementation, modify code, or when the graph doesn't have the answer.

Important: For any question about the codebase architecture, module relationships,
or "how does X work?", query the mind place FIRST. Reading raw files costs 20-100x
more tokens than querying the graph.
`;

const STALE_GRAPH_INSTRUCTIONS = `
## ⚠️ Mind Place Graph is STALE

The knowledge graph at \`${OUT_DIR}/${GRAPH_FILE}\` is older than some source files.
The graph may contain outdated information. Before answering codebase questions,
run \`mindplace_build\` to refresh it. Use \`update=true\` for a fast incremental
rebuild that only re-extracts changed files.
`;

const NO_GRAPH_INSTRUCTIONS = `
## Mind Place Knowledge Graph

No knowledge graph exists yet for this project. You MUST build it immediately
before answering any codebase question — no need to ask permission.

1. Run \`mindplace_build\` as your very first action when the user asks about
   the codebase, architecture, imports, or any source file relationships.
2. The build is fast (local tree-sitter parsing, no network or LLM cost) and
   will save massive tokens on every subsequent question.
3. Do NOT read source files before the graph is built. The graph answers
   structural questions at a fraction of the token cost.

Once the graph is built, use \`mindplace_query\` / \`mindplace_explain\` before
raw file reads.
`;

export default function (pi: ExtensionAPI) {
  // Register tools
  pi.registerTool(MindplaceBuildTool);
  pi.registerTool(MindplaceQueryTool);
  pi.registerTool(MindplaceExplainTool);

  // When graph exists: inject query-first instructions + always-on file map.
  // When no graph: tell agent to auto-build before reading files.
  pi.on("before_agent_start", (event, ctx) => {
    const gp = graphPath(ctx.cwd);

    if (existsSync(gp)) {
      const { stale } = checkStaleness(ctx.cwd);
      const fileMap = buildFileContext(ctx.cwd);
      let prompt = GRAPH_FIRST_INSTRUCTIONS;
      if (stale) {
        prompt += STALE_GRAPH_INSTRUCTIONS;
      }
      if (fileMap) {
        prompt += "\n" + fileMap;
      }
      return { systemPrompt: event.systemPrompt + prompt };
    } else {
      return {
        systemPrompt: event.systemPrompt + NO_GRAPH_INSTRUCTIONS,
      };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // After a query, remind the agent that source locations are available
  // ═══════════════════════════════════════════════════════════════
  pi.on("tool_result", (event) => {
    if (event.toolName !== "mindplace_query" || event.isError) return;

    const content = event.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          block.text +=
            "\n\n_Source locations shown above — use \`read\` with the exact file path and line to see the full implementation when needed._";
        }
      }
    }
  });

  // Shortcut command
  pi.registerCommand("mindplace", {
    description: "Build or query the mind place knowledge graph",
    handler: async (args, ctx) => {
      const gp = graphPath(ctx.cwd);
      const graphExists = existsSync(gp);

      if (!args) {
        if (graphExists) {
          ctx.ui.notify(
            "Mind Place exists — just ask me about the codebase!",
            "info",
          );
        } else {
          ctx.ui.notify(
            "No Mind Place yet. Run mindplace_build or say 'build the mind place'.",
            "info",
          );
        }
        return;
      }

      if (args === "build" || args === "rebuild") {
        pi.sendUserMessage("Run mindplace_build to scan the codebase.", {
          deliverAs: "steer",
        });
      } else {
        pi.sendUserMessage(
          `Query the mind place: "${args}"`,
          { deliverAs: "steer" },
        );
      }
    },
  });
}
