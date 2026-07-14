/**
 * In-memory knowledge graph with persistence and query operations.
 *
 * Uses a simple adjacency list (Map<string, Set<string>>) instead of
 * a full graph library to minimize dependencies. Supports:
 *   - Building from extraction results
 *   - PageRank centrality computation
 *   - Community detection (Louvain algorithm)
 *   - Serialization to/from JSON
 *   - God node identification
 */

import type { GraphNode, GraphEdge, ExtractionResult, GraphStats } from "./types.ts";

export class KnowledgeGraph {
  nodes: Map<string, GraphNode> = new Map();
  edges: GraphEdge[] = [];
  /** Adjacency: nodeId → set of connected nodeIds */
  adjacency: Map<string, Set<string>> = new Map();
  /** Outgoing edges: nodeId → set of target nodeIds (for directed mode) */
  outgoing: Map<string, Set<string>> = new Map();
  /** Whether the graph preserves edge direction */
  isDirected: boolean = false;

  /** Build graph from extraction results */
  static fromExtraction(result: ExtractionResult, directed: boolean = false): KnowledgeGraph {
    const kg = new KnowledgeGraph();

    for (const node of result.nodes) {
      kg.nodes.set(node.id, { ...node });
      kg.adjacency.set(node.id, new Set());
    }

    kg.isDirected = directed;

    for (const edge of result.edges) {
      // Only add edges where both endpoints exist in the node set
      if (kg.nodes.has(edge.source) && kg.nodes.has(edge.target)) {
        kg.edges.push({ ...edge });
        kg.adjacency.get(edge.source)?.add(edge.target);
        kg.adjacency.get(edge.target)?.add(edge.source);
        // Track outgoing direction
        const out = kg.outgoing.get(edge.source) ?? new Set();
        out.add(edge.target);
        kg.outgoing.set(edge.source, out);
      }
    }

    return kg;
  }

  /** Add nodes/edges from another extraction (for incremental updates) */
  merge(result: ExtractionResult): void {
    for (const node of result.nodes) {
      if (!this.nodes.has(node.id)) {
        this.nodes.set(node.id, { ...node });
        this.adjacency.set(node.id, new Set());
      }
    }
    for (const edge of result.edges) {
      if (this.nodes.has(edge.source) && this.nodes.has(edge.target)) {
        this.edges.push({ ...edge });
        this.adjacency.get(edge.source)?.add(edge.target);
        this.adjacency.get(edge.target)?.add(edge.source);
      }
    }
  }

  /** Compute PageRank centrality scores (power iteration, no numpy needed) */
  computeCentrality(alpha: number = 0.85, epsilon: number = 1e-6, maxIter: number = 100): void {
    const N = this.nodes.size;
    if (N === 0) return;

    const nodeIds = [...this.nodes.keys()];
    const idx = new Map<string, number>();
    nodeIds.forEach((id, i) => idx.set(id, i));

    // Initialize scores
    let scores = new Float64Array(N).fill(1.0 / N);

    for (let iter = 0; iter < maxIter; iter++) {
      const newScores = new Float64Array(N).fill((1 - alpha) / N);

      for (const [i, id] of nodeIds.entries()) {
        const neighbors = this.adjacency.get(id);
        if (!neighbors || neighbors.size === 0) continue;

        const contribution = (alpha * scores[i]) / neighbors.size;
        for (const neighborId of neighbors) {
          const j = idx.get(neighborId);
          if (j !== undefined) newScores[j] += contribution;
        }
      }

      // Check convergence
      let diff = 0;
      for (let i = 0; i < N; i++) {
        diff += Math.abs(newScores[i] - scores[i]);
      }
      scores = newScores;

      if (diff < N * epsilon) break;
    }

    // Store centrality on nodes
    for (const [i, id] of nodeIds.entries()) {
      const node = this.nodes.get(id);
      if (node) node.centrality = Math.round(scores[i] * 1000) / 1000;
    }
  }

  /** Louvain community detection */
  detectCommunities(): Map<number, string[]> {
    const communities = new Map<string, number>();
    const nodeIds = [...this.nodes.keys()];

    // Initialize: each node is its own community
    nodeIds.forEach((id, i) => communities.set(id, i));

    const m = this.edges.length;
    if (m === 0) return new Map();

    let improved = true;
    let iterations = 0;

    while (improved && iterations < 50) {
      improved = false;
      iterations++;

      for (const nodeId of nodeIds) {
        const currentComm = communities.get(nodeId)!;
        const neighbors = this.adjacency.get(nodeId) ?? new Set();

        // Collect neighbor community weights
        const commWeights = new Map<number, number>();
        for (const neighborId of neighbors) {
          const nc = communities.get(neighborId);
          if (nc === undefined) continue;
          commWeights.set(nc, (commWeights.get(nc) || 0) + 1);
        }

        // Find best community
        let bestComm = currentComm;
        let bestGain = 0;

        for (const [comm, weight] of commWeights) {
          // Simple modularity gain: more neighbors in same community = better
          if (weight > bestGain && comm !== currentComm) {
            // Additional check: don't move to empty communities
            const currentSize = [...communities.values()].filter(c => c === currentComm).length;
            if (currentSize > 1 || weight > 0) {
              bestGain = weight;
              bestComm = comm;
            }
          }
        }

        if (bestComm !== currentComm) {
          communities.set(nodeId, bestComm);
          improved = true;
        }
      }
    }

    // Group by community
    const result = new Map<number, string[]>();
    for (const [nodeId, comm] of communities) {
      const group = result.get(comm) ?? [];
      group.push(nodeId);
      result.set(comm, group);
    }

    // Store community on nodes
    for (const [nodeId, comm] of communities) {
      const node = this.nodes.get(nodeId);
      if (node) node.community = comm;
    }

    return result;
  }

  /** God nodes — highest degree nodes */
  topNodes(limit: number = 10): Array<{ id: string; label: string; degree: number }> {
    return [...this.nodes.values()]
      .map(n => ({
        id: n.id,
        label: n.label,
        degree: this.adjacency.get(n.id)?.size ?? 0,
      }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, limit);
  }

  /** Stats summary */
  stats(): GraphStats {
    const communities = new Set<number>();
    for (const node of this.nodes.values()) {
      if (node.community !== undefined) communities.add(node.community);
    }
    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.length,
      communityCount: communities.size,
      godNodes: this.topNodes(5),
    };
  }

  /**
   * File-level ranking via PageRank on the file dependency graph.
   * Only file-type nodes are scored; edges are import relations.
   * Returns top files with their contained symbols, ranked by centrality.
   */
  fileRanking(
    limit: number = 40,
  ): Array<{ file: string; score: number; symbols: Array<{ label: string; type: string; centrality: number }> }> {
    // Collect file nodes
    const fileNodes = [...this.nodes.values()].filter(n => n.type === "file");
    if (fileNodes.length === 0) return [];

    // Build file-level adjacency + lookup: sourceFile → file node ID
    const fileAdj = new Map<string, Set<string>>();
    const sourceToId = new Map<string, string>();

    for (const fn of fileNodes) {
      fileAdj.set(fn.id, new Set());
      if (fn.sourceFile) sourceToId.set(fn.sourceFile, fn.id);
    }

    // Add edges: file A imports file B (O(e) with O(1) lookups)
    for (const edge of this.edges) {
      if (edge.relation !== "imports") continue;
      const srcFile = this.nodes.get(edge.source)?.sourceFile;
      const tgtFile = this.nodes.get(edge.target)?.sourceFile;
      if (!srcFile || !tgtFile || srcFile === tgtFile) continue;

      const srcId = sourceToId.get(srcFile);
      const tgtId = sourceToId.get(tgtFile);
      if (!srcId || !tgtId) continue;

      fileAdj.get(srcId)?.add(tgtId);
    }

    // PageRank on file graph
    const N = fileNodes.length;
    const alpha = 0.85;
    const epsilon = 1e-6;
    const nodeIds = fileNodes.map(n => n.id);
    const idx = new Map<string, number>();
    nodeIds.forEach((id, i) => idx.set(id, i));

    let scores = new Float64Array(N).fill(1.0 / N);

    for (let iter = 0; iter < 100; iter++) {
      const newScores = new Float64Array(N).fill((1 - alpha) / N);

      for (let i = 0; i < N; i++) {
        const neighbors = fileAdj.get(nodeIds[i]);
        if (!neighbors || neighbors.size === 0) continue;
        const contribution = (alpha * scores[i]) / neighbors.size;
        for (const nid of neighbors) {
          const j = idx.get(nid);
          if (j !== undefined) newScores[j] += contribution;
        }
      }

      let diff = 0;
      for (let i = 0; i < N; i++) diff += Math.abs(newScores[i] - scores[i]);
      scores = newScores;
      if (diff < N * epsilon) break;
    }

    // Build result: file → score + top symbols
    const ranked = nodeIds
      .map((id, i) => ({ id, score: scores[i] }))
      .sort((a, b) => b.score - a.score);

    const result: Array<{ file: string; score: number; symbols: Array<{ label: string; type: string; centrality: number }> }> = [];

    for (const entry of ranked.slice(0, limit)) {
      const fileNode = this.nodes.get(entry.id);
      if (!fileNode) continue;

      // Find symbols contained in this file
      const symbols = [...this.nodes.values()]
        .filter(n => n.sourceFile === fileNode.sourceFile && n.type !== "file")
        .map(n => ({ label: n.label, type: n.type, centrality: n.centrality ?? 0 }))
        .sort((a, b) => b.centrality - a.centrality)
        .slice(0, 6);

      result.push({
        file: fileNode.sourceFile ?? fileNode.label,
        score: Math.round(entry.score * 1000) / 1000,
        symbols,
      });
    }

    return result;
  }

  /** Serialize to JSON-serializable object */
  toJSON(): object {
    return {
      nodes: [...this.nodes.values()],
      edges: this.edges,
    };
  }

  /** Deserialize from JSON */
  static fromJSON(data: { nodes: GraphNode[]; edges: GraphEdge[] }): KnowledgeGraph {
    return KnowledgeGraph.fromExtraction(data);
  }
}
