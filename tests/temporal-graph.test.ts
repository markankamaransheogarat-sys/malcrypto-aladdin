import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFragilityMetrics } from "../src/aladdin/fragility.js";
import type { FragilityMetrics } from "../src/core/types.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Bi-Temporal Knowledge Graph", () => {
  it("enforces bi-temporal validity windows (no look-ahead bias)", () => {
    const g = new TemporalKnowledgeGraph(false);
    const t1 = 1000;
    const t2 = 2000;

    g.addNode({
      id: "A",
      label: "A",
      tier: "ACTOR",
      sector: "Test",
      aliases: ["a"],
      systemicWeight: 0.9,
    });
    g.addNode({
      id: "B",
      label: "B",
      tier: "CRYPTO_ASSET",
      sector: "Test",
      aliases: ["b"],
      systemicWeight: 0.9,
    });

    g.upsertEdge({
      id: "A__MACRO_BETA__B",
      source: "A",
      target: "B",
      relation: "MACRO_BETA",
      weight: 0.8,
      stressWeight: 0.9,
      lagMinutes: 5,
      polarity: 1,
      confidence: 0.9,
      origin: "CAUSAL_ENGINE",
      validFrom: t2,
      validTo: null,
    });

    assert.equal(
      g.getActiveEdges(t1).length,
      0,
      "Edge must not exist before validFrom",
    );
    assert.equal(
      g.getActiveEdges(t2).length,
      1,
      "Edge must exist at validFrom",
    );

    g.expireEdge("A__MACRO_BETA__B", 3000);
    assert.equal(
      g.getActiveEdges(3000).length,
      0,
      "Expired edge must be inactive",
    );
  });

  it("propagates Huang -> NVDA -> BTC & AI tokens contagion shock", () => {
    const g = new TemporalKnowledgeGraph(true);
    const fragMap = new Map<string, FragilityMetrics>();
    fragMap.set(
      "CRYPTO_BTC",
      computeFragilityMetrics({
        nodeId: "CRYPTO_BTC",
        openInterestUsd: 20_000_000_000,
        spotDepth2PctUsd: 160_000_000,
        fundingRate8h: 0.0004,
        longShortRatio: 1.6,
        nearestLiqClusterPct: 1.5,
      }),
    );

    const results = g.propagateShock(
      { triggerNodeId: "ACTOR_HUANG", shockPct: -10 },
      fragMap,
      "STRESS_CORRELATION_ONE",
      4,
    );

    const nvda = results.find((r) => r.nodeId === "EQ_NVDA");
    const btc = results.find((r) => r.nodeId === "CRYPTO_BTC");
    const render = results.find((r) => r.nodeId === "CRYPTO_RENDER");

    assert.ok(nvda && nvda.expectedMovePct < -5, "NVDA should drop sharply");
    assert.ok(
      btc && btc.expectedMovePct < -2,
      "BTC should receive propagated shock",
    );
    assert.ok(
      render && render.expectedMovePct < -4,
      "RENDER should drop via AI narrative",
    );
  });

  it("prunes weak hypothesis edges", () => {
    const g = new TemporalKnowledgeGraph(true);
    g.upsertEdge({
      id: "weak_hyp",
      source: "ACTOR_HUANG",
      target: "CRYPTO_LINK",
      relation: "NARRATIVE_PROXY",
      weight: 0.2,
      stressWeight: 0.3,
      lagMinutes: 10,
      polarity: 1,
      confidence: 0.3,
      origin: "NEWS_HYPOTHESIS",
      validFrom: 1000,
      validTo: null,
    });
    const pruned = g.pruneWeakEdges(0.45, 2000);
    assert.equal(pruned, 1);
  });
});
