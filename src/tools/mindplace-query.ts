/**
 * mindplace_query tool — query the knowledge graph
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { KnowledgeGraph } from "../graph.ts";
import { query, formatQueryResult, buildSourceSnippets } from "../query.ts";
import { refreshGraphIfStale } from "../refresh.ts";
import { stalenessBanner } from "../watcher.ts";

const OUT_DIR = "graph-out";

export const MindplaceQueryTool = {
  name: "mindplace_query",
  label: "Query Mind Place",
  description:
    "Query the code knowledge graph with a natural-language question. Returns the most relevant code entities and their relationships — much faster than reading raw files. The graph must be built first with mindplace_build.",
  promptSnippet: "Query the code knowledge graph for relevant entities",
  promptGuidelines: [
    "Use mindplace_query FIRST when answering questions about the codebase structure, relationships between files/functions, or tracing data flow. Only read raw files after the graph has oriented you.",
  ],
  parameters: Type.Object({
    question: Type.String({
      description: "Natural-language question about the codebase",
    }),
    budget: Type.Optional(
      Type.Number({
        description: "Token budget for the result (default: 4000)",
        default: 4000,
      }),
    ),
    minScore: Type.Optional(
      Type.Number({
        description: "Minimum relevance score 0..1 (default: 0.15). Lower = more results, higher = only strong matches.",
        default: 0.15,
      }),
    ),
  }),
  async execute(
    _toolCallId: string,
    params: { question: string; budget?: number; minScore?: number },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const root = ctx.cwd;
    const graphPath = join(root, OUT_DIR, "graph.json");

    // Auto-refresh graph if stale before querying
    await refreshGraphIfStale(root);

    if (!existsSync(graphPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No knowledge graph found. Pi-mindplace attempted to build it automatically but failed. Try running mindplace_build manually.`,
          },
        ],
        details: { graphExists: false },
        isError: true,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(graphPath, "utf-8"));
      const kg = KnowledgeGraph.fromJSON(raw);

      const budget = params.budget ?? 4000;
      const result = query(kg, params.question, budget, "bfs", params.minScore ?? 0.15);
      let formatted = formatQueryResult(result);

      // Verbatim source for the top symbols — no need to read the files again
      formatted += buildSourceSnippets(root, result.nodes, budget);

      // Staleness banner: edits still inside the watcher's debounce window
      formatted += stalenessBanner(root);

      return {
        content: [{ type: "text" as const, text: formatted }],
        details: {
          nodesReturned: result.nodes.length,
          tokensUsed: result.tokensUsed,
          budget: result.budget,
          coverage: result.coverage,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to query mind place: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        details: { error: String(err) },
        isError: true,
      };
    }
  },
};
