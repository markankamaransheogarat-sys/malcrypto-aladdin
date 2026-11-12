import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFragilityMetrics } from "../src/aladdin/fragility.js";
import {
  AladdinSimulator,
  CalibrationTracker,
} from "../src/aladdin/simulator.js";
import type { FragilityMetrics } from "../src/core/types.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Aladdin Fragility, Simulator & Calibration", () => {
  it("classifies overleveraged thin-book market as TINDERBOX", () => {
    const frag = computeFragilityMetrics({
      nodeId: "CRYPTO_BTC",
      openInterestUsd: 25_000_000_000,
      spotDepth2PctUsd: 150_000_000,
      fundingRate8h: 0.0006,
      longShortRatio: 2.1,
      nearestLiqClusterPct: 1.0,
    });
    assert.equal(frag.status, "TINDERBOX");
    assert.ok(frag.fragilityScore >= 68);
  });

  it("produces normalized scenario probabilities summing to 1.00", () => {
    const g = new TemporalKnowledgeGraph(true);
    const sim = new AladdinSimulator();
    const fragMap = new Map<string, FragilityMetrics>();
    fragMap.set(
      "CRYPTO_BTC",
      computeFragilityMetrics({
        nodeId: "CRYPTO_BTC",
        openInterestUsd: 18_000_000_000,
        spotDepth2PctUsd: 200_000_000,
        fundingRate8h: 0.0002,
        longShortRatio: 1.3,
        nearestLiqClusterPct: 2.5,
      }),
    );

    const res = sim.simulateShock(
      g,
      { triggerNodeId: "ACTOR_HUANG", shockPct: -9 },
      fragMap,
      "STRESS_CORRELATION_ONE",
    );

    const sumProb = res.scenarios.reduce((acc, s) => acc + s.probability, 0);
    assert.ok(
      Math.abs(sumProb - 1.0) < 0.02,
      `Probabilities sum to ${sumProb}`,
    );
    assert.ok(res.totalSystemicRiskScore > 20);
  });

  it("tracks Brier Score calibration across resolved predictions", () => {
    const tracker = new CalibrationTracker();
    tracker.recordPrediction({
      id: "p1",
      createdAt: 1000,
      targetNodeId: "CRYPTO_BTC",
      triggerNodeId: "EQ_NVDA",
      predictedCrashProb: 0.7,
      predictedMovePct: -6,
      horizonHours: 12,
      thresholdPct: -4,
    });
    tracker.resolvePrediction("p1", -5.5, 2000);
    const rep = tracker.getReport();
    assert.equal(rep.resolvedCount, 1);
    assert.equal(rep.hitRate, 1);
    assert.ok(Math.abs(rep.brierScore - 0.09) < 1e-4);
  });
});
