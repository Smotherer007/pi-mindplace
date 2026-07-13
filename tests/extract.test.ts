/**
 * Tests for AST extraction
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { extract } from "../src/extract.ts";
import { detect } from "../src/detect.ts";
import { resolve } from "node:path";

const FIXTURES = resolve(import.meta.dirname ?? ".", "fixtures", "sample-project");

describe("extract", () => {
  it("extracts functions from TypeScript files", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    assert.ok(result.nodes.length > 0, "should extract at least one node");
    assert.ok(result.edges.length > 0, "should extract at least one edge");

    // Should find authenticateUser function
    const authFn = result.nodes.find(n => n.label === "authenticateUser" && n.type === "function");
    assert.ok(authFn, "should extract authenticateUser function");
    assert.equal(authFn?.type, "function");
    assert.ok(authFn?.sourceFile.includes("auth.ts"), "should reference correct source file");
  });

  it("extracts classes from TypeScript files", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    const controller = result.nodes.find(n => n.label === "UserController" && n.type === "class");
    assert.ok(controller, "should extract UserController class");
    assert.equal(controller?.type, "class");
  });

  it("extracts import edges", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    const importEdges = result.edges.filter(e => e.relation === "imports");
    assert.ok(importEdges.length > 0, "should extract import edges");
  });

  it("extracts call edges for known functions", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    const callEdges = result.edges.filter(e => e.relation === "calls");
    // authenticateUser calls validateCredentials
    assert.ok(callEdges.length > 0, "should extract call edges");
  });

  it("assigns unique IDs to all nodes", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    const ids = result.nodes.map(n => n.id);
    const uniqueIds = new Set(ids);
    assert.equal(ids.length, uniqueIds.size, "all node IDs should be unique");
  });

  it("includes source locations", () => {
    const detected = detect(FIXTURES);
    const result = extract(FIXTURES, detected.files);

    for (const node of result.nodes) {
      if (node.type !== "file") {
        assert.ok(node.sourceLocation, `node ${node.label} should have sourceLocation`);
        assert.match(node.sourceLocation, /^L\d+/, "sourceLocation should start with L");
      }
    }
  });
});
