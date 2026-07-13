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
 *   - before_agent_start: inject graph-first instructions into system prompt
 *   - tool_call hook: gently remind agent about the graph on read calls
 *
 * Tools:
 *   - mindplace_build: Scan project and build the knowledge graph
 *   - mindplace_query: Query the graph with a natural-language question
 *   - mindplace_explain: Get details about a specific entity
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { MindplaceBuildTool } from "./src/tools/mindplace-build.ts";
import { MindplaceQueryTool } from "./src/tools/mindplace-query.ts";
import { MindplaceExplainTool } from "./src/tools/mindplace-explain.ts";

const OUT_DIR = "graph-out";
const GRAPH_FILE = "graph.json";

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, GRAPH_FILE);
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

const NO_GRAPH_INSTRUCTIONS = `
## Mind Place Knowledge Graph

No knowledge graph exists yet for this project. If the user asks a question about
the codebase, architecture, or how something works, you MUST offer to build the
graph first BEFORE reading any source files:

1. Tell the user: "I can build a mind place of this codebase first. It takes a few
   seconds and will save tokens on every subsequent question. Want me to?"
2. Wait for confirmation before running \`mindplace_build\`.
3. Never automatically build without asking. Building scans all source files and
   costs time, so it must be explicit.

Once the graph is built, all future codebase questions will use it automatically.
`;

export default function (pi: ExtensionAPI) {
  // Register tools
  pi.registerTool(MindplaceBuildTool);
  pi.registerTool(MindplaceQueryTool);
  pi.registerTool(MindplaceExplainTool);

  // When graph exists: inject query-first instructions.
  // When no graph: tell agent to offer building before reading files.
  // This is the token savings mechanism.
  pi.on("before_agent_start", (event, ctx) => {
    const gp = graphPath(ctx.cwd);

    if (existsSync(gp)) {
      return {
        systemPrompt: event.systemPrompt + GRAPH_FIRST_INSTRUCTIONS,
      };
    } else {
      return {
        systemPrompt: event.systemPrompt + NO_GRAPH_INSTRUCTIONS,
      };
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // Gentle nudge on read calls — block reading source files when
  // the graph exists and the agent hasn't queried it first.
  // We don't fully block (that breaks editing), but we can warn.
  // ═══════════════════════════════════════════════════════════════
  pi.on("tool_call", (event, ctx) => {
    // Only intercept read calls
    if (event.toolName !== "read") return;

    const gp = graphPath(ctx.cwd);
    if (!existsSync(gp)) return;

    const input = event.input as { path?: string } | undefined;
    const filePath = input?.path ?? "";
    if (!filePath) return;

    // Only nudge for source code files with content
    const codeExts = [".ts", ".js", ".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts",
      ".py", ".pyi", ".go", ".sh", ".bash", ".json",
    ];
    const isSource = codeExts.some(ext => filePath.endsWith(ext));
    if (!isSource) return;
    if (filePath.includes(OUT_DIR)) return;
    if (filePath.includes("node_modules")) return;
    if (filePath.includes(".pi")) return;

    // Check file size — only nudge on larger files (small configs are fine)
    try {
      const absPath = join(ctx.cwd, filePath);
      const stats = statSync(absPath);
      if (stats.size < 500) return; // tiny files are fine
    } catch {
      return;
    }

    // Don't block — pi's tool_call can return { block: true } but that's too
    // aggressive for editing workflows. Instead we rely on the system prompt
    // instructions (above) to steer the agent toward graph queries.
    // This hook is passive: it just verifies the graph exists, which the
    // system prompt already handles.
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
