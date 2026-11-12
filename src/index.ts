/**
 * MalCrypto Aladdin — Node / CLI Entry Point
 * Runs live causal discovery + Huang/NVDA cascade stress test in terminal.
 */

import { computeFragilityMetrics } from "./aladdin/fragility.js";
import { AladdinSimulator } from "./aladdin/simulator.js";
import { CausalDiscoveryEngine } from "./causal/lead-lag.js";
import { NewsLinkerEngine } from "./causal/news-linker.js";
import { detectMarketRegime } from "./core/math.js";
import type { FragilityMetrics } from "./core/types.js";
import {
  fetchBinanceKlinesReturns,
  fetchBinancePerpFragilityInputs,
  fetchBinanceSpotQuotes,
} from "./feeds/live-feeds.js";
import { TemporalKnowledgeGraph } from "./graph/temporal-graph.js";

export {
  AladdinSimulator,
  CausalDiscoveryEngine,
  NewsLinkerEngine,
  TemporalKnowledgeGraph,
  computeFragilityMetrics,
  detectMarketRegime,
};

async function runCli(): Promise<void> {
  console.log("=== MALCRYPTO ALADDIN — CROSS-MARKET CAUSAL RISK ENGINE ===\n");
  const graph = new TemporalKnowledgeGraph(true);
  const simulator = new AladdinSimulator();
  const newsLinker = new NewsLinkerEngine();
  const causal = new CausalDiscoveryEngine();

  console.log(
    `Loaded Bi-Temporal Skeleton: ${graph.getAllNodes().length} nodes, ${graph.getActiveEdges().length} active edges.`,
  );

  // Fetch live quotes & BTC fragility if online
  const [quotes, btcPerp] = await Promise.all([
    fetchBinanceSpotQuotes(),
    fetchBinancePerpFragilityInputs("BTCUSDT"),
  ]);

  const fragilityMap = new Map<string, FragilityMetrics>();
  if (btcPerp) {
    const btcFrag = computeFragilityMetrics({
      nodeId: "CRYPTO_BTC",
      openInterestUsd: btcPerp.openInterestUsd,
      spotDepth2PctUsd: btcPerp.spotDepth2PctUsd,
      fundingRate8h: btcPerp.fundingRate8h,
      longShortRatio: 1.42,
      nearestLiqClusterPct: 2.2,
    });
    fragilityMap.set("CRYPTO_BTC", btcFrag);
    console.log(
      `Live BTC Perp: $${btcPerp.markPrice.toFixed(0)} | OI: $${(btcPerp.openInterestUsd / 1e9).toFixed(2)}B | Fragility: ${btcFrag.fragilityScore}/100 (${btcFrag.status})`,
    );
  } else {
    fragilityMap.set(
      "CRYPTO_BTC",
      computeFragilityMetrics({
        nodeId: "CRYPTO_BTC",
        openInterestUsd: 18_500_000_000,
        spotDepth2PctUsd: 190_000_000,
        fundingRate8h: 0.00035,
        longShortRatio: 1.65,
        nearestLiqClusterPct: 1.8,
      }),
    );
  }

  if (quotes.length > 0) {
    console.log(
      `Live Crypto Quotes: ${quotes.map((q) => `${q.symbol.replace("USDT", "")} $${q.price} (${q.change24hPct > 0 ? "+" : ""}${q.change24hPct.toFixed(2)}%)`).join(" | ")}`,
    );
  }

  // Run live Lead-Lag discovery on 15m klines if available
  const [btcRet, ethRet, renderRet, taoRet] = await Promise.all([
    fetchBinanceKlinesReturns("BTCUSDT", "15m", 96),
    fetchBinanceKlinesReturns("ETHUSDT", "15m", 96),
    fetchBinanceKlinesReturns("RENDERUSDT", "15m", 96),
    fetchBinanceKlinesReturns("TAOUSDT", "15m", 96),
  ]);

  if (btcRet.length >= 30 && renderRet.length >= 30) {
    const series = new Map<string, number[]>([
      ["CRYPTO_BTC", btcRet],
      ["CRYPTO_ETH", ethRet],
      ["CRYPTO_RENDER", renderRet],
      ["CRYPTO_TAO", taoRet],
    ]);
    const discoveries = causal.discoverLinks(series, {
      barMinutes: 15,
      maxLagSteps: 3,
    });
    const sig = discoveries.filter((d) => d.fdrSignificant);
    console.log(
      `\nOnline Causal Discovery: ${sig.length} FDR-significant links detected.`,
    );
    for (const d of sig.slice(0, 5)) {
      console.log(
        `  ${d.source} -> ${d.target} | lag=${d.lagMinutes}m | corr=${d.correlation} | TailBeta=${d.tailBetaDownside} | p=${d.pValue}`,
      );
    }
  }

  // Demonstrate Huang / NVIDIA Shock Simulation
  const sampleEvent = newsLinker.analyzeNews(graph, {
    id: "cli_demo_huang",
    title:
      "Jensen Huang warns on NVIDIA AI GPU export restrictions and guidance slowdown",
    source: "Reuters",
    marketPriorPositiveProb: 0.82,
  });

  console.log(`\nParsed News Event: "${sampleEvent.title}"`);
  console.log(
    `  Matched: [${sampleEvent.matchedNodes.join(", ")}] | Sentiment: ${sampleEvent.sentiment} | Surprise: ${sampleEvent.surpriseScore} | Status: ${sampleEvent.status}`,
  );

  const sim = simulator.simulateShock(
    graph,
    {
      triggerNodeId: "ACTOR_HUANG",
      shockPct: -9.5,
      regime: "STRESS_CORRELATION_ONE",
    },
    fragilityMap,
  );

  console.log(
    `\nAladdin Contagion Simulation (Systemic Risk: ${sim.totalSystemicRiskScore}/100):`,
  );
  for (const n of sim.affectedNodes.slice(0, 7)) {
    console.log(
      `  [Hop ${n.hop} | ~${n.etaMinutes}m] ${n.label.padEnd(24)} Expected: ${n.expectedMovePct}% (P10: ${n.p10MovePct}% .. P90: ${n.p90MovePct}%)`,
    );
  }
  console.log("\nScenario Tree:");
  for (const s of sim.scenarios) {
    console.log(
      `  • ${s.label}: ${(s.probability * 100).toFixed(0)}% (BTC ${s.btcExpectedPct}%)`,
    );
  }
}

const isDirectExecution =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("index.ts") ||
    process.argv[1].endsWith("index.js"));

if (isDirectExecution) {
  runCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
