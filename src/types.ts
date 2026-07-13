/**
 * Core types for pi-mindplace
 */

export interface GraphNode {
  id: string;
  label: string;
  type: string;
  sourceFile: string;
  sourceLocation?: string;
  community?: number;
  centrality?: number;
  description?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: string;
  confidence: "EXTRACTED" | "INFERRED" | "AMBIGUOUS";
  confidenceScore?: number;
}

export interface ExtractionResult {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface DetectResult {
  root: string;
  files: string[];
  totalFiles: number;
  byExtension: Record<string, number>;
}

export interface QueryResult {
  question: string;
  mode: "bfs" | "dfs";
  nodes: GraphNode[];
  edges: GraphEdge[];
  tokensUsed: number;
  budget: number;
  coverage: number;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  communityCount: number;
  godNodes: Array<{ id: string; label: string; degree: number }>;
}

/** Supported file extensions → language grammar key */
export const CODE_EXTENSIONS: Record<string, string> = {
  // JavaScript family
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  // TypeScript family
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  // Python
  ".py": "python",
  ".pyi": "python",
  // Go
  ".go": "go",
  // Bash
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  // Config
  ".json": "json",
};

/** File extensions that may contain useful info but aren't parsed as code */
export const DOC_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".yaml", ".yml", ".toml", ".xml",
  ".html", ".css", ".scss", ".less",
]);
