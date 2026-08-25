/**
 * File watcher — keeps the knowledge graph fresh while you code.
 *
 * Lazy-started from refreshGraphIfStale (every query/explain call flows
 * through it). Watches the graph root recursively (ReadDirectoryChangesW on
 * Windows), debounces bursts of edits, then triggers the same refresh path
 * queries use — so an edit lands in the graph within ~2s, before the next query.
 *
 * Failure mode: if fs.watch is unsupported or errors, the watcher simply
 * doesn't run and the existing lazy refresh on query still covers freshness.
 */

import { watch, type FSWatcher } from "node:fs";
import { join, extname } from "node:path";
import { CODE_EXTENSIONS } from "./types.ts";

const DEBOUNCE_MS = 2000;
const MAX_PENDING = 100;

/** Directories that can write files constantly — never watch or index them */
const IGNORE_DIRS = new Set([
  "node_modules", "vendor", "dist", "build", ".git", "graph-out",
  ".cache", ".next", "__pycache__", "coverage", ".pi", ".codegraph",
  "storage", "test-results",
]);

interface WatcherState {
  watcher: FSWatcher;
  pending: Set<string>; // absolute paths changed within the debounce window
  timer: NodeJS.Timeout | null;
}

const watchers = new Map<string, WatcherState>();

function isWatchedFile(absPath: string, root: string): boolean {
  const rel = absPath.slice(root.length).replace(/\\/g, "/");
  const parts = rel.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  if (parts.some(p => p.startsWith("."))) return false;
  if (parts.slice(0, -1).some(p => IGNORE_DIRS.has(p))) return false;
  return extname(parts[parts.length - 1]).toLowerCase() in CODE_EXTENSIONS;
}

async function fire(root: string): Promise<void> {
  const st = watchers.get(root);
  if (!st) return;
  st.timer = null;
  try {
    // Dynamic import breaks the static cycle refresh.ts -> watcher.ts
    const { refreshGraphIfStale } = await import("./refresh.ts");
    await refreshGraphIfStale(root);
  } catch {
    // Never let watcher failures surface — lazy refresh covers us
  }
  st.pending.clear();
}

/**
 * Start (once) a recursive watcher for the given graph root.
 * No-op if already watching or if fs.watch is unavailable.
 */
export function ensureWatcher(root: string): void {
  if (watchers.has(root)) return;

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      const st = watchers.get(root);
      if (!st) return;
      const abs = join(root, filename.toString());
      if (!isWatchedFile(abs, root)) return;

      if (st.pending.size < MAX_PENDING) st.pending.add(abs);
      if (st.timer) clearTimeout(st.timer);
      st.timer = setTimeout(() => fire(root), DEBOUNCE_MS);
    });
  } catch {
    return; // watching unsupported — lazy refresh still keeps things fresh
  }

  watcher.on("error", () => {
    // Transient watch errors (EPERM on some dirs) are fine; queries still refresh lazily
  });

  // unref: the watcher must never keep a process alive. Inside pi (long-running)
  // it keeps working; one-shot scripts exit naturally when done — no manual kill.
  watcher.unref();

  watchers.set(root, { watcher, pending: new Set(), timer: null });
}

/**
 * Root-relative files changed within the debounce window — used for the
 * staleness banner so the agent knows the graph may lag an edit by ~2s.
 */
export function pendingChanges(root: string): string[] {
  const st = watchers.get(root);
  if (!st || st.pending.size === 0) return [];
  return [...st.pending].map(p => p.slice(root.length + 1));
}

/** Banner text for files changed within the debounce window; "" when none. */
export function stalenessBanner(root: string): string {
  const pending = pendingChanges(root);
  if (pending.length === 0) return "";
  const shown = pending.slice(0, 5).map(f => `\`${f}\``).join(", ");
  return `⚠️ ${pending.length} file(s) changed in the last ~2s — the graph may not include them yet: ${shown}\n\n`;
}
