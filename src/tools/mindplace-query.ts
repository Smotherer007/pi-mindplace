/**
 * mindplace_query tool — query the knowledge graph
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { KnowledgeGraph } from "../graph.ts";
import { query, formatQueryResult } from "../query.ts";

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
  }),
  async execute(
    _toolCallId: string,
    params: { question: string; budget?: number },
    _signal: AbortSignal,
    _onUpdate: (update: unknown) => void,
    ctx: ExtensionContext,
  ) {
    const graphPath = join(ctx.cwd, OUT_DIR, "graph.json");

    if (!existsSync(graphPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `No knowledge graph found. Run mindplace_build first to scan the codebase.`,
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
      const result = query(kg, params.question, budget);
      const formatted = formatQueryResult(result);

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
