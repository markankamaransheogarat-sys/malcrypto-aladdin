import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CausalDiscoveryEngine } from "../src/causal/lead-lag.js";
import { NewsLinkerEngine } from "../src/causal/news-linker.js";
import { TemporalKnowledgeGraph } from "../src/graph/temporal-graph.js";

describe("Causal Discovery & News-to-Graph Linker", () => {
  it("discovers lagged causal link and syncs to graph", () => {
    const engine = new CausalDiscoveryEngine();
    const graph = new TemporalKnowledgeGraph(true);

    const nvda: number[] = [];
    const render: number[] = [0];
    for (let i = 0; i < 100; i++) {
      nvda.push(Math.sin(i * 0.41) * 3 + Math.cos(i * 0.77));
    }
    for (let i = 1; i < 100; i++) {
      render.push(0.85 * nvda[i - 1] + 0.1 * Math.sin(i * 1.9));
    }

    const discoveries = engine.discoverLinks(
      new Map([
        ["EQ_NVDA", nvda],
        ["CRYPTO_RENDER", render],
      ]),
      { barMinutes: 15, maxLagSteps: 2 },
    );

    const match = discoveries.find(
      (d) =>
        d.source === "EQ_NVDA" &&
        d.target === "CRYPTO_RENDER" &&
        d.fdrSignificant,
    );
    assert.ok(
      match,
      "Should discover EQ_NVDA -> CRYPTO_RENDER with FDR significance",
    );

    const synced = engine.syncDiscoveriesToGraph(graph, discoveries);
    assert.ok(synced >= 1);
    assert.ok(
      graph
        .getActiveEdges()
        .some((e) => e.id === "EQ_NVDA__CAUSAL_LAG__CRYPTO_RENDER"),
    );
  });

  it("links entities in news and computes Surprise Score vs Polymarket prior", () => {
    const linker = new NewsLinkerEngine();
    const graph = new TemporalKnowledgeGraph(true);

    const ev = linker.analyzeNews(graph, {
      id: "n1",
      title:
        "Jensen Huang warns on NVIDIA slowdown as SEC probes crypto exchange",
      source: "Reuters",
      marketPriorPositiveProb: 0.85,
    });

    assert.equal(ev.status, "VERIFIED");
    assert.ok(ev.matchedNodes.includes("ACTOR_HUANG"));
    assert.ok(ev.matchedNodes.includes("EQ_NVDA"));
    assert.ok(ev.matchedNodes.includes("ACTOR_SEC"));
    assert.ok(
      ev.surpriseScore < -0.5,
      `Expected strong negative surprise, got ${ev.surpriseScore}`,
    );
  });
});
