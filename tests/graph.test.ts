/**
 * Tests for graph operations
 */

import { describe, it } from "node:test";
import { strict as assert } from "node:assert";
import { KnowledgeGraph } from "../src/graph.ts";
import type { ExtractionResult } from "../src/types.ts";

function sampleExtraction(): ExtractionResult {
  return {
    nodes: [
      { id: "mod_a", label: "moduleA", type: "file", sourceFile: "a.ts" },
      { id: "a_login", label: "login", type: "function", sourceFile: "a.ts", sourceLocation: "L10" },
      { id: "a_validate", label: "validate", type: "function", sourceFile: "a.ts", sourceLocation: "L20" },
      { id: "mod_b", label: "moduleB", type: "file", sourceFile: "b.ts" },
      { id: "b_process", label: "process", type: "function", sourceFile: "b.ts", sourceLocation: "L5" },
    ],
    edges: [
      { source: "mod_a", target: "a_login", relation: "contains", confidence: "EXTRACTED" as const },
      { source: "mod_a", target: "a_validate", relation: "contains", confidence: "EXTRACTED" as const },
      { source: "a_login", target: "a_validate", relation: "calls", confidence: "INFERRED" as const, confidenceScore: 0.85 },
      { source: "mod_b", target: "b_process", relation: "contains", confidence: "EXTRACTED" as const },
      { source: "b_process", target: "a_login", relation: "calls", confidence: "INFERRED" as const, confidenceScore: 0.95 },
    ],
  };
}

describe("KnowledgeGraph", () => {
  it("builds from extraction result", () => {
    const kg = KnowledgeGraph.fromExtraction(sampleExtraction());

    assert.equal(kg.nodes.size, 5);
    assert.equal(kg.edges.length, 5);
  });

  it("filters edges with missing endpoints", () => {
    const ext = sampleExtraction();
    ext.edges.push({
      source: "nonexistent",
      target: "a_login",
      relation: "calls",
      confidence: "INFERRED",
    });

    const kg = KnowledgeGraph.fromExtraction(ext);
    // Edge with missing source should be filtered
    assert.equal(kg.edges.length, 5);
  });

  it("computes PageRank centrality", () => {
    const kg = KnowledgeGraph.fromExtraction(sampleExtraction());
    kg.computeCentrality();

    for (const node of kg.nodes.values()) {
      assert.ok(node.centrality !== undefined, `node ${node.id} should have centrality`);
      assert.ok(node.centrality! >= 0 && node.centrality! <= 1, "centrality should be 0..1");
    }
  });

  it("detects communities", () => {
    const kg = KnowledgeGraph.fromExtraction(sampleExtraction());
    kg.computeCentrality();
    const communities = kg.detectCommunities();

    assert.ok(communities.size > 0, "should find at least one community");
    // Every node should be assigned
    for (const nodeId of kg.nodes.keys()) {
      const node = kg.nodes.get(nodeId);
      assert.ok(node?.community !== undefined, `node ${nodeId} should have community`);
    }
  });

  it("identifies god nodes", () => {
    const kg = KnowledgeGraph.fromExtraction(sampleExtraction());
    kg.computeCentrality();
    kg.detectCommunities();

    const top = kg.topNodes(3);
    assert.ok(top.length > 0, "should find god nodes");
    assert.ok(top[0].degree >= top[1]?.degree ?? 0, "should be sorted by degree");
  });

  it("serializes to and from JSON", () => {
    const kg1 = KnowledgeGraph.fromExtraction(sampleExtraction());
    kg1.computeCentrality();
    kg1.detectCommunities();

    const json = JSON.stringify(kg1.toJSON());
    const parsed = JSON.parse(json);
    const kg2 = KnowledgeGraph.fromJSON(parsed);

    assert.equal(kg2.nodes.size, kg1.nodes.size);
    assert.equal(kg2.edges.length, kg1.edges.length);
  });

  it("merges incremental extractions", () => {
    const kg = KnowledgeGraph.fromExtraction(sampleExtraction());

    const extra: ExtractionResult = {
      nodes: [
        { id: "c_helper", label: "helper", type: "function", sourceFile: "c.ts", sourceLocation: "L1" },
        { id: "mod_c", label: "moduleC", type: "file", sourceFile: "c.ts" },
      ],
      edges: [
        { source: "mod_c", target: "c_helper", relation: "contains", confidence: "EXTRACTED" as const },
      ],
    };

    kg.merge(extra);
    assert.equal(kg.nodes.size, 7);
    assert.equal(kg.edges.length, 6);
  });
});
