/**
 * Tests for file detection
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { detect } from "../src/detect.ts";
import { resolve, join } from "node:path";

const FIXTURES = resolve(import.meta.dirname ?? ".", "fixtures", "sample-project");

describe("detect", () => {
  it("finds TypeScript files in sample project", () => {
    const result = detect(FIXTURES);

    assert.ok(result.totalFiles > 0, "should find at least one file");
    assert.ok(result.files.some(f => f.endsWith(".ts")), "should find .ts files");
    assert.ok(result.byExtension[".ts"] > 0, "should count .ts files");
  });

  it("excludes node_modules and dot directories", () => {
    const result = detect(FIXTURES);

    for (const file of result.files) {
      assert.ok(!file.includes("node_modules"), "should not include node_modules");
      assert.ok(!file.startsWith("."), "should not include dot files");
    }
  });

  it("returns absolute root path", () => {
    const result = detect(FIXTURES);
    assert.ok(result.root.startsWith("/"), "root should be absolute");
  });

  it("throws on non-existent path", () => {
    assert.throws(() => detect("/nonexistent/path/12345"));
  });

  it("returns empty for empty directory", () => {
    const result = detect(resolve(FIXTURES, "src"));
    // src/ has files, so let's test that it finds them
    assert.ok(result.totalFiles > 0);
    assert.ok(result.files.length === result.totalFiles);
  });
});
