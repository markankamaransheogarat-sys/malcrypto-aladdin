import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BacktestEngine,
  HISTORICAL_SHOCK_CASES,
} from "../src/aladdin/backtest.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Bi-Temporal Historical Shock Replay (BacktestEngine)", () => {
  it("replays all historical shock cases with high directional accuracy and valid Brier Score", () => {
    const graph = new TemporalKnowledgeGraph(true);
    const engine = new BacktestEngine();

    const summary = engine.runHistoricalSuite(graph, HISTORICAL_SHOCK_CASES);

    assert.equal(summary.cases.length, HISTORICAL_SHOCK_CASES.length);
    assert.ok(
      summary.overallDirectionalAccuracy >= 0.85,
      `Expected directional accuracy >= 0.85, got ${summary.overallDirectionalAccuracy}`,
    );
    assert.ok(
      summary.overallBrierScore >= 0 && summary.overallBrierScore <= 0.35,
      `Expected calibrated Brier score <= 0.35, got ${summary.overallBrierScore}`,
    );
    assert.ok(
      summary.overallIntervalCoverage > 0.3,
      "Expected meaningful P10..P90 coverage",
    );
  });
});
