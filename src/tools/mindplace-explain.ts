/**
 * mindplace_explain tool — explain a specific node in the graph
 */

import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { KnowledgeGraph } from "../graph.ts";
import type { GraphEdge } from "../types.ts";

const OUT_DIR = "graph-out";

export const MindplaceExplainTool = {
  name: "mindplace_explain",
  label: "Explain Mind Place Node",
  description:
    "Get detailed information about a specific entity (function, class, module) in the codebase — its connections, where it's defined, and what it depends on.",
  promptSnippet: "Explain a code entity and its connections",
  parameters: Type.Object({
    name: Type.String({
      description: "Name of the function, class, or module to explain",
    }),
  }),
  async execute(
    _toolCallId: string,
    params: { name: string },
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
            text: `No knowledge graph found. Run mindplace_build first.`,
          },
        ],
        details: { graphExists: false },
        isError: true,
      };
    }

    try {
      const raw = JSON.parse(readFileSync(graphPath, "utf-8"));
      const kg = KnowledgeGraph.fromJSON(raw);

      // Find matching nodes
      const searchLower = params.name.toLowerCase();
      const matches = [...kg.nodes.values()].filter(
        n => n.label.toLowerCase().includes(searchLower) || n.id.toLowerCase().includes(searchLower),
      );

      if (matches.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No entity matching "${params.name}" found in the knowledge graph.`,
            },
          ],
          details: { matchesFound: 0 },
        };
      }

      // Build explanation for top match
      const node = matches[0];
      const neighbors = kg.adjacency.get(node.id) ?? new Set();

      // Find edges connected to this node
      const connectedEdges: GraphEdge[] = kg.edges.filter(
        e => e.source === node.id || e.target === node.id,
      );

      // Group edges by relation
      const byRelation = new Map<string, string[]>();
      for (const edge of connectedEdges) {
        const otherId = edge.source === node.id ? edge.target : edge.source;
        const otherNode = kg.nodes.get(otherId);
        if (!otherNode) continue;

        const direction = edge.source === node.id ? "→" : "←";
        const label = `${direction} **${otherNode.label}** (${otherNode.type}) _${edge.confidence}_`;
        const rel = edge.relation;
        const group = byRelation.get(rel) ?? [];
        group.push(label);
        byRelation.set(rel, group);
      }

      const lines = [
        `## ${node.label} (${node.type})`,
        `- **File:** \`${node.sourceFile}\`${node.sourceLocation ? ` ${node.sourceLocation}` : ""}`,
        `- **Community:** ${node.community ?? "—"}`,
        `- **Connections:** ${neighbors.size}`,
      ];

      if (node.description) {
        lines.push(`- **Description:** ${node.description}`);
      }

      lines.push("");

      if (byRelation.size > 0) {
        lines.push("### Relationships");
        for (const [relation, items] of byRelation) {
          lines.push(`#### ${relation} (${items.length})`);
          for (const item of items.slice(0, 15)) {
            lines.push(`- ${item}`);
          }
          if (items.length > 15) {
            lines.push(`  _... and ${items.length - 15} more_`);
          }
          lines.push("");
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          nodeId: node.id,
          connections: neighbors.size,
          matchesTotal: matches.length,
        },
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to explain: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        details: { error: String(err) },
        isError: true,
      };
    }
  },
};
