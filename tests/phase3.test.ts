import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CalibrationTracker } from "../src/aladdin/simulator.js";
import { AutoGraphExpander } from "../src/graph/auto-discovery.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Phase 3: Autonomous Graph Expansion & Auto-Resolver", () => {
  it("discovers new nodes from headlines and links them to matched nodes", () => {
    const graph = new TemporalKnowledgeGraph(true);
    const expander = new AutoGraphExpander();

    const beforeCount = graph.getAllNodes().length;
    const { newNodes, newEdges } = expander.discoverFromHeadline(
      graph,
      "Hyperliquid volume surges as Anthropic partners with NVIDIA",
      ["EQ_NVDA"],
      1000,
    );

    assert.ok(
      newNodes.some((n) => n.label === "Hyperliquid"),
      "Should discover Hyperliquid",
    );
    assert.ok(newEdges.length >= 1, "Should link Hyperliquid to EQ_NVDA");
    assert.ok(graph.getAllNodes().length > beforeCount);
  });

  it("ingests top DeFiLlama protocols above TVL threshold", () => {
    const graph = new TemporalKnowledgeGraph(true);
    const expander = new AutoGraphExpander();

    const added = expander.ingestTopProtocols(graph, [
      {
        name: "EigenLayer",
        symbol: "EIGEN",
        tvlUsd: 12_000_000_000,
        category: "Restaking",
      },
      {
        name: "TinyDex",
        symbol: "TINY",
        tvlUsd: 50_000_000,
        category: "Dexes",
      },
    ]);

    assert.equal(added, 1);
    assert.ok(graph.getNode("PROTO_EIGENLAYER"));
    assert.equal(graph.getNode("PROTO_TINYDEX"), undefined);
  });

  it("auto-resolves due predictions against live price and reinforces edge confidence", () => {
    const graph = new TemporalKnowledgeGraph(true);
    const tracker = new CalibrationTracker();

    const now = Date.now();
    graph.updateNodeMarketData("CRYPTO_BTC", { price: 85_000 });

    const edgeBefore = graph
      .getActiveEdges(now)
      .find((e) => e.source === "EQ_QQQ" && e.target === "CRYPTO_BTC")!;

    tracker.recordPrediction({
      id: "due_pred",
      createdAt: now - 13 * 3600_000,
      targetNodeId: "CRYPTO_BTC",
      triggerNodeId: "EQ_QQQ",
      predictedCrashProb: 0.75,
      predictedMovePct: -8,
      horizonHours: 12,
      thresholdPct: -5,
      baselinePrice: 100_000,
    });

    const resolved = tracker.autoResolveDuePredictions(graph, now);
    assert.equal(resolved, 1);
    assert.equal(tracker.getReport().hitRate, 1);

    const edgeAfter = graph
      .getActiveEdges(now)
      .find((e) => e.source === "EQ_QQQ" && e.target === "CRYPTO_BTC")!;
    assert.ok(edgeAfter.confidence > edgeBefore.confidence);
  });
});
