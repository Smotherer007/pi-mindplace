/**
 * File detection — walks a directory tree and identifies code files
 * that can be parsed by tree-sitter.
 */

import { readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { DetectResult } from "./types.ts";
import { CODE_EXTENSIONS } from "./types.ts";

const DEFAULT_IGNORE = new Set([
  "node_modules",
  ".git",
  ".pi",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  "coverage",
  ".nyc_output",
  "graph-out",
  ".graphify",
]);

const MAX_FILES = 10_000;

export function detect(rootPath: string): DetectResult {
  const absRoot = resolve(rootPath);

  if (!existsSync(absRoot)) {
    throw new Error(`Path does not exist: ${absRoot}`);
  }

  const files: string[] = [];
  const byExtension: Record<string, number> = {};

  function walk(dir: string): void {
    if (files.length >= MAX_FILES) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const name of entries) {
      if (files.length >= MAX_FILES) return;
      if (DEFAULT_IGNORE.has(name)) continue;
      if (name.startsWith(".")) continue;

      const full = join(dir, name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }

      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        const rel = relative(absRoot, full);
        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";

        if (ext in CODE_EXTENSIONS) {
          files.push(rel);
          byExtension[ext] = (byExtension[ext] || 0) + 1;
        }
      }
    }
  }

  // Always walk from root
  walk(absRoot);

  return {
    root: absRoot,
    files: files.sort(),
    totalFiles: files.length,
    byExtension,
  };
}
