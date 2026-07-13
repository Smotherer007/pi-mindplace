/**
 * Tests for query engine
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KnowledgeGraph } from "../src/graph.ts";
import { query, formatQueryResult } from "../src/query.ts";
import type { ExtractionResult } from "../src/types.ts";

function sampleGraph(): KnowledgeGraph {
  const ext: ExtractionResult = {
    nodes: [
      { id: "mod_auth", label: "auth.ts", type: "file", sourceFile: "src/auth.ts" },
      {
        id: "src_auth_authenticateUser",
        label: "authenticateUser",
        type: "function",
        sourceFile: "src/auth.ts",
        sourceLocation: "L1",
        description: "Validates user credentials and returns JWT token",
      },
      {
        id: "src_auth_validateCredentials",
        label: "validateCredentials",
        type: "function",
        sourceFile: "src/auth.ts",
        sourceLocation: "L8",
        description: "Checks username and password are valid",
      },
      {
        id: "src_auth_hashPassword",
        label: "hashPassword",
        type: "function",
        sourceFile: "src/auth.ts",
        sourceLocation: "L15",
        description: "Hashes password using bcrypt",
      },
      { id: "mod_middleware", label: "middleware.ts", type: "file", sourceFile: "src/middleware.ts" },
      {
        id: "src_middleware_JWTMiddleware",
        label: "JWTMiddleware",
        type: "class",
        sourceFile: "src/middleware.ts",
        sourceLocation: "L3",
        description: "Intercepts HTTP requests and validates Authorization header",
      },
    ],
    edges: [
      { source: "mod_auth", target: "src_auth_authenticateUser", relation: "contains", confidence: "EXTRACTED" },
      { source: "mod_auth", target: "src_auth_validateCredentials", relation: "contains", confidence: "EXTRACTED" },
      { source: "mod_auth", target: "src_auth_hashPassword", relation: "contains", confidence: "EXTRACTED" },
      { source: "mod_middleware", target: "src_middleware_JWTMiddleware", relation: "contains", confidence: "EXTRACTED" },
      { source: "src_auth_authenticateUser", target: "src_auth_validateCredentials", relation: "calls", confidence: "INFERRED", confidenceScore: 0.95 },
      { source: "src_auth_authenticateUser", target: "src_auth_hashPassword", relation: "calls", confidence: "INFERRED", confidenceScore: 0.85 },
      { source: "src_middleware_JWTMiddleware", target: "src_auth_authenticateUser", relation: "calls", confidence: "INFERRED", confidenceScore: 0.9 },
    ],
  };

  const kg = KnowledgeGraph.fromExtraction(ext);
  kg.computeCentrality();
  kg.detectCommunities();
  return kg;
}

describe("query", () => {
  it("returns relevant nodes for auth query", () => {
    const kg = sampleGraph();
    const result = query(kg, "authenticate user validation", 4000);

    assert.ok(result.nodes.length > 0, "should find relevant nodes");
    assert.ok(result.tokensUsed > 0, "should track token usage");
    assert.ok(result.tokensUsed <= result.budget, "should stay within budget");
  });

  it("finds authenticateUser when asking about auth", () => {
    const kg = sampleGraph();
    const result = query(kg, "authenticateUser flow", 4000);

    const authNode = result.nodes.find(n => n.label === "authenticateUser");
    assert.ok(authNode, "should find authenticateUser node");
  });

  it("returns edges between selected nodes", () => {
    const kg = sampleGraph();
    const result = query(kg, "JWT middleware authentication", 4000);

    // Should include the edge between JWTMiddleware and authenticateUser
    const hasEdge = result.edges.some(
      e => e.source.includes("JWTMiddleware") && e.target.includes("authenticateUser"),
    );
    assert.ok(hasEdge, "should include relationships between found nodes");
  });

  it("respects token budget", () => {
    const kg = sampleGraph();
    const small = query(kg, "auth", 500);
    const large = query(kg, "auth", 4000);

    assert.ok(small.tokensUsed <= 500 + 50, "small budget should be respected");
    assert.ok(large.nodes.length >= small.nodes.length, "larger budget should return more nodes");
  });

  it("formats results as markdown", () => {
    const kg = sampleGraph();
    const result = query(kg, "authenticate user", 2000);
    const formatted = formatQueryResult(result);

    assert.ok(formatted.includes("Mind Place"), "should include title");
    assert.ok(formatted.includes("authenticate"), "should include query tokens");
    assert.ok(formatted.length > 50, "should have content");
  });

  it("handles empty graph gracefully", () => {
    const kg = KnowledgeGraph.fromExtraction({ nodes: [], edges: [] });
    const result = query(kg, "anything", 1000);

    assert.equal(result.nodes.length, 0);
    assert.equal(result.tokensUsed, 0);
  });

  it("returns empty for unrelated query", () => {
    const kg = sampleGraph();
    const result = query(kg, "quantum chromodynamics meson decay", 1000);

    // Should return very few or no nodes (nothing about physics in the graph)
    assert.ok(result.nodes.length <= 2, "should find few nodes for unrelated query");
  });
});
