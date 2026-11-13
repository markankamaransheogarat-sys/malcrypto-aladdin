import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ExecutiveBriefingEngine } from "../src/aladdin/briefing.js";
import { computeFragilityMetrics } from "../src/aladdin/fragility.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Executive Briefing & Extended Players DB", () => {
  it("loads 50+ key market players in the skeleton graph", () => {
    const g = new TemporalKnowledgeGraph(true);
    assert.ok(
      g.getAllNodes().length >= 50,
      `Expected >= 50 nodes, got ${g.getAllNodes().length}`,
    );
    assert.ok(g.getNode("ACTOR_BOJ"));
    assert.ok(g.getNode("INFRA_COINBASE"));
    assert.ok(g.getNode("INFRA_USDE"));
  });

  it("produces actionable LONG/SHORT/WAIT verdict and 24h/3d/7d probability horizons", () => {
    const engine = new ExecutiveBriefingEngine();
    const frag = computeFragilityMetrics({
      nodeId: "CRYPTO_BTC",
      openInterestUsd: 22_000_000_000,
      spotDepth2PctUsd: 150_000_000,
      fundingRate8h: 0.0005,
      longShortRatio: 1.9,
      nearestLiqClusterPct: 1.2,
    });

    const b = engine.generate({
      btcPrice: 71_000,
      btcChange24hPct: -3.5,
      dvolPct: 45,
      btcFragility: frag,
      fearGreed: { value: 82, classification: "Extreme Greed" },
      stablePegs: [
        {
          symbol: "USDT",
          nodeId: "INFRA_USDT",
          price: 0.996,
          pegDeviationBps: -40,
        },
      ],
      liq5mLongUsd: 400_000,
      liq5mShortUsd: 50_000,
      regime: "STRESS_CORRELATION_ONE",
      newsFeed: [],
    });

    assert.equal(b.verdict, "SHORT");
    assert.equal(b.horizons.length, 3);
    for (const h of b.horizons) {
      assert.equal(h.probUpPct + h.probRangePct + h.probDownPct, 100);
      assert.ok(h.p10Price < h.p50Price && h.p50Price < h.p90Price);
    }
  });
});
