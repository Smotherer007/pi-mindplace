/**
 * Graph refresh — silent auto-sync before queries.
 *
 * Called from mindplace_query / mindplace_explain (and by the file watcher).
 * Detects source files, compares mtimes against the persisted graph, and
 * rebuilds incrementally (via extract's cache) only when something changed.
 * Lazy-starts the file watcher so subsequent edits land in the graph without
 * another full query-time rebuild.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { detect } from "./detect.ts";
import { extract } from "./extract.ts";
import { KnowledgeGraph } from "./graph.ts";
import { ensureWatcher } from "./watcher.ts";

const OUT_DIR = "graph-out";
const GRAPH_FILE = "graph.json";

function graphPath(cwd: string): string {
  return join(cwd, OUT_DIR, GRAPH_FILE);
}

/** Safe stat that returns -1 on error */
function fsStatMtime(absPath: string): number {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return -1;
  }
}

/**
 * Check staleness by comparing source file mtimes against graph mtime.
 * Reuses the already-computed detect() result to avoid a second walk.
 */
function isStale(cwd: string, files: string[]): boolean {
  const gp = graphPath(cwd);
  if (!existsSync(gp)) return true;

  const graphMtime = statSync(gp).mtimeMs;

  // Check every file's mtime — a burst of edits can leave older files
  // stale past a small window.
  const sorted = files
    .map(f => ({ file: f, mtime: fsStatMtime(join(cwd, f)) }))
    .filter((f): f is { file: string; mtime: number } => f.mtime !== -1)
    .sort((a, b) => b.mtime - a.mtime);

  for (const { mtime } of sorted) {
    if (mtime > graphMtime) return true;
  }

  return false;
}

/**
 * Refresh the graph if stale — silent auto-sync before queries.
 * Uses a single detect() call shared between staleness check and extraction.
 */
export async function refreshGraphIfStale(cwd: string): Promise<{ refreshed: boolean; reason?: string }> {
  ensureWatcher(cwd); // lazy start — one watcher per graph root
  const gp = graphPath(cwd);
  const exists = existsSync(gp);

  let detected;
  try {
    detected = detect(cwd);
  } catch {
    return { refreshed: false, reason: "detection failed" };
  }
  if (detected.files.length === 0) return { refreshed: false, reason: "no supported files" };

  try {
    if (exists && !isStale(cwd, detected.files)) {
      return { refreshed: false, reason: "fresh" };
    }

    // No graph or stale — extract incrementally via the file cache
    const cacheDir = join(cwd, OUT_DIR, "cache");
    const extResult = await extract(cwd, detected.files, cacheDir, false);

    let kg: KnowledgeGraph;
    if (exists) {
      const existing = JSON.parse(readFileSync(gp, "utf-8"));
      kg = KnowledgeGraph.fromJSON(existing);
      kg.merge(extResult);
    } else {
      kg = KnowledgeGraph.fromExtraction(extResult);
    }

    kg.computeCentrality();
    kg.detectCommunities();

    mkdirSync(join(cwd, OUT_DIR), { recursive: true });
    writeFileSync(gp, JSON.stringify(kg.toJSON(), null, 2), "utf-8");

    return {
      refreshed: true,
      reason: exists
        ? `incremental (${extResult.extracted} files re-extracted)`
        : "initial build",
    };
  } catch (err) {
    return { refreshed: false, reason: `refresh failed: ${err}` };
  }
}
