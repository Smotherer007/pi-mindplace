/**
 * Token-budget-aware graph query engine.
 *
 * Given a natural-language question, scores every graph node against
 * the query using TF-IDF + cosine similarity, then performs BFS or DFS
 * traversal to build a subgraph that fits within the token budget.
 *
 * Design mirrors graphify/slurp's approach:
 *   1. Tokenize query and node labels (camelCase/snake_case splitting)
 *   2. TF-IDF scoring with smoothed IDF
 *   3. Greedy BFS/DFS from top-scoring nodes, tracking token spend
 *   4. Return subgraph with score breakdown
 */

import type { GraphNode, GraphEdge, QueryResult } from "./types.ts";
import { KnowledgeGraph } from "./graph.ts";

/** Approximate tokens per character — conservative estimate */
const CHARS_PER_TOKEN = 4;

/** Tokenize text: split camelCase and snake_case */
function tokenize(text: string): string[] {
  const tokens: string[] = [];

  // Split on camelCase boundaries and non-alphanumeric chars
  const words = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/);

  for (const word of words) {
    const lower = word.toLowerCase();
    if (lower.length > 1) tokens.push(lower);
  }

  return tokens;
}

/** Estimate tokens in a string */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** TF-IDF scorer */
class TfIdfScorer {
  private idf = new Map<string, number>();
  private docs: Map<string, string[]> = new Map();

  constructor(nodes: Map<string, GraphNode>) {
    // Build document corpus: one doc per node (label + description)
    let docCount = 0;
    for (const [id, node] of nodes) {
      const text = `${node.label} ${node.description ?? ""} ${node.type}`;
      const tokens = tokenize(text);
      if (tokens.length > 0) {
        this.docs.set(id, tokens);
        docCount++;
      }
    }

    // Compute document frequencies
    const df = new Map<string, number>();
    for (const tokens of this.docs.values()) {
      const seen = new Set<string>();
      for (const t of tokens) {
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) || 0) + 1);
        }
      }
    }

    // Compute IDF: log((N + 1) / (df + 1)) + 1 (smoothing like scikit-learn)
    for (const [term, freq] of df) {
      this.idf.set(term, Math.log((docCount + 1) / (freq + 1)) + 1);
    }
  }

  /** Score a node against query tokens. Returns 0..1 */
  score(nodeId: string, queryTokens: string[]): number {
    const docTokens = this.docs.get(nodeId);
    if (!docTokens || docTokens.length === 0 || queryTokens.length === 0) return 0;

    // Compute TF vector for the document
    const tf = new Map<string, number>();
    for (const t of docTokens) {
      tf.set(t, (tf.get(t) || 0) + 1);
    }

    // Substring matching for compound words like "authenticateUser"
    let substringBonus = 0;
    const label = docTokens.join(' ');
    for (const qt of queryTokens) {
      if (label.includes(qt)) substringBonus += 0.3;
    }

    // Cosine similarity between query and document vectors
    let dotProduct = 0;
    let queryNorm = 0;
    let docNorm = 0;

    // Query vector: all query tokens with weight 1 * IDF
    const queryWeights = new Map<string, number>();
    for (const t of queryTokens) {
      const idf = this.idf.get(t) ?? 0.5;
      queryWeights.set(t, idf);
      queryNorm += idf * idf;
    }
    queryNorm = Math.sqrt(queryNorm);
    if (queryNorm === 0) return 0;

    // Doc vector: TF * IDF
    const docWeights = new Map<string, number>();
    for (const [t, freq] of tf) {
      const idf = this.idf.get(t) ?? 0.5;
      const weight = freq * idf;
      docWeights.set(t, weight);
      docNorm += weight * weight;

      if (queryWeights.has(t)) {
        dotProduct += queryWeights.get(t)! * weight;
      }
    }
    docNorm = Math.sqrt(docNorm);
    if (docNorm === 0) return 0;

    const cosine = dotProduct / (queryNorm * docNorm);
    return Math.min(1, cosine + substringBonus);
  }
}

/** Format a single node as markdown */
function formatNode(node: GraphNode, includeDescription: boolean = true): string {
  let text = `### ${node.label} (${node.type})`;
  if (node.sourceLocation) text += ` · score: ${(node.centrality ?? 0).toFixed(2)}`;
  if (includeDescription && node.description) {
    text += `\n${node.description}`;
  }
  text += `\n→ File: ${node.sourceFile}`;
  if (node.sourceLocation) text += ` ${node.sourceLocation}`;
  return text;
}

/**
 * Query the knowledge graph.
 *
 * @param kg The knowledge graph
 * @param question Natural-language question
 * @param budget Token budget for the result
 * @param mode "bfs" (broad context) or "dfs" (trace a specific path)
 * @param minScore Minimum relevance score (0..1)
 */
export function query(
  kg: KnowledgeGraph,
  question: string,
  budget: number = 4000,
  mode: "bfs" | "dfs" = "bfs",
  minScore: number = 0.15,
): QueryResult {
  if (kg.nodes.size === 0) {
    return { question, mode, nodes: [], edges: [], tokensUsed: 0, budget, coverage: 0 };
  }

  const queryTokens = tokenize(question);
  const scorer = new TfIdfScorer(kg.nodes);

  // Score all nodes
  const scored = new Map<string, number>();
  for (const nodeId of kg.nodes.keys()) {
    const s = scorer.score(nodeId, queryTokens);
    if (s >= minScore) {
      scored.set(nodeId, s);
    }
  }

  // Sort by score descending
  const ranked = [...scored.entries()].sort((a, b) => b[1] - a[1]);

  // Greedy subgraph selection with token budget
  const selectedNodes = new Set<string>();
  const selectedEdges: GraphEdge[] = [];
  let tokensUsed = 0;

  // Header tokens
  tokensUsed += estimateTokens(
    `## Mind Place Query: "${question}" (budget: ${budget} tokens)\n\n`,
  );

  const queue: string[] = [];

  if (mode === "bfs") {
    // Start from top-scored nodes
    for (const [nodeId] of ranked) {
      if (tokensUsed >= budget * 0.9) break;
      addNodeToResult(nodeId, ranked.find(([id]) => id === nodeId)?.[1] ?? 0);
      // Also add neighbors
      const neighbors = kg.adjacency.get(nodeId);
      if (neighbors) {
        for (const neighborId of neighbors) {
          if (!selectedNodes.has(neighborId) && tokensUsed < budget * 0.9) {
            const neighborScore = scored.get(neighborId) ?? 0;
            if (neighborScore >= minScore * 0.5) {
              addNodeToResult(neighborId, neighborScore);
            }
          }
        }
      }
    }
  } else {
    // DFS: follow the top-scored path deeply
    const visited = new Set<string>();
    function dfs(currentId: string, depth: number): void {
      if (depth > 5 || tokensUsed >= budget * 0.9) return;
      visited.add(currentId);
      addNodeToResult(currentId, scored.get(currentId) ?? 0);

      const neighbors = [...(kg.adjacency.get(currentId) ?? [])]
        .filter(n => !visited.has(n))
        .sort((a, b) => (scored.get(b) ?? 0) - (scored.get(a) ?? 0));

      for (const neighborId of neighbors.slice(0, 3)) {
        if (!visited.has(neighborId)) {
          dfs(neighborId, depth + 1);
        }
      }
    }

    if (ranked.length > 0) {
      dfs(ranked[0][0], 0);
    }
  }

  function addNodeToResult(nodeId: string, score: number): void {
    if (selectedNodes.has(nodeId)) return;
    const node = kg.nodes.get(nodeId);
    if (!node) return;

    const formatted = formatNode(node, true);
    const nodeTokens = estimateTokens(formatted + "\n\n");
    if (tokensUsed + nodeTokens > budget * 0.95) return;

    selectedNodes.add(nodeId);
    tokensUsed += nodeTokens;
  }

  // Add edges between selected nodes
  for (const edge of kg.edges) {
    if (selectedNodes.has(edge.source) && selectedNodes.has(edge.target)) {
      if (!selectedEdges.some(e =>
        (e.source === edge.source && e.target === edge.target) ||
        (e.source === edge.target && e.target === edge.source),
      )) {
        selectedEdges.push(edge);
      }
    }
  }

  const resultNodes = [...selectedNodes].map(id => kg.nodes.get(id)!).filter(Boolean);

  return {
    question,
    mode,
    nodes: resultNodes,
    edges: selectedEdges,
    tokensUsed,
    budget,
    coverage: kg.nodes.size > 0 ? selectedNodes.size / kg.nodes.size : 0,
  };
}

/** Format query result as markdown for the LLM */
export function formatQueryResult(result: QueryResult): string {
  const lines: string[] = [];

  lines.push(`## Mind Place: "${result.question}"`);
  lines.push(`_${result.nodes.length} nodes · ${result.tokensUsed}/${result.budget} tokens (${(result.coverage * 100).toFixed(1)}% coverage)_`);
  lines.push("");

  // Group nodes by type
  const byType = new Map<string, GraphNode[]>();
  for (const node of result.nodes) {
    const group = byType.get(node.type) ?? [];
    group.push(node);
    byType.set(node.type, group);
  }

  for (const [type, nodes] of byType) {
    if (type === "file") continue; // skip file nodes in output
    lines.push(`### ${type.charAt(0).toUpperCase() + type.slice(1)}s`);
    for (const node of nodes) {
      lines.push(formatNode(node, false));
      lines.push("");
    }
  }

  // Key relationships
  if (result.edges.length > 0) {
    lines.push("### Key Relationships");
    const shown = new Set<string>();
    for (const edge of result.edges.slice(0, 10)) {
      const srcNode = result.nodes.find(n => n.id === edge.source);
      const tgtNode = result.nodes.find(n => n.id === edge.target);
      if (srcNode && tgtNode) {
        const key = `${edge.source}→${edge.target}`;
        if (!shown.has(key)) {
          shown.add(key);
          lines.push(`- ${srcNode.label} → **${edge.relation}** → ${tgtNode.label}${edge.confidence === "INFERRED" ? " _[inferred]_" : ""}`);
        }
      }
    }
  }

  // Remaining nodes hint
  const totalNodes = result.nodes.length;
  if (totalNodes > 0 && result.coverage < 1) {
    lines.push("");
    lines.push(`---`);
    lines.push(`💡 ${totalNodes} additional connected nodes available — increase budget to include them`);
  }

  return lines.join("\n");
}
