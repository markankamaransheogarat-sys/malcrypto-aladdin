import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFragilityMetrics } from "../src/aladdin/fragility.js";
import {
  DEFAULT_PORTFOLIO,
  PortfolioRiskEngine,
} from "../src/aladdin/portfolio.js";
import { AladdinSimulator } from "../src/aladdin/simulator.js";
import type { FragilityMetrics } from "../src/core/types.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Phase 4: Portfolio Risk Overlay & DVOL VaR", () => {
  it("computes portfolio expected drawdown, P10..P90 bands, DVOL VaR, and hedge advice", () => {
    const graph = new TemporalKnowledgeGraph(true);
    const simEngine = new AladdinSimulator();
    const portEngine = new PortfolioRiskEngine();

    const fragMap = new Map<string, FragilityMetrics>();
    fragMap.set(
      "CRYPTO_BTC",
      computeFragilityMetrics({
        nodeId: "CRYPTO_BTC",
        openInterestUsd: 20_000_000_000,
        spotDepth2PctUsd: 160_000_000,
        fundingRate8h: 0.0004,
        longShortRatio: 1.65,
        nearestLiqClusterPct: 1.5,
      }),
    );

    const sim = simEngine.simulateShock(
      graph,
      {
        triggerNodeId: "ACTOR_HUANG",
        shockPct: -10,
        regime: "STRESS_CORRELATION_ONE",
      },
      fragMap,
      "STRESS_CORRELATION_ONE",
    );

    const rep = portEngine.evaluateImpact(DEFAULT_PORTFOLIO, sim, 42.5);
    assert.equal(rep.totalUsd, 110_000);
    assert.ok(
      rep.expectedPnlUsd < -5000,
      `Expected negative PnL, got ${rep.expectedPnlUsd}`,
    );
    assert.ok(rep.p10PnlUsd < rep.expectedPnlUsd);
    assert.ok(rep.var95DailyUsd > 0 && rep.var99DailyUsd > rep.var95DailyUsd);
    assert.ok(rep.hedgeRecommendation.includes("HIGH DOWNSIDE"));
  });
});
