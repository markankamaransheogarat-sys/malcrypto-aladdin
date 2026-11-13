/**
 * 24/7 GitHub Actions Watchdog Runner
 * Fetches CORS-free TradFi + Crypto + News + DeFi feeds, expands the Bi-Temporal Graph,
 * runs Granger & Aladdin risk checks, dispatches Telegram alerts, and persists data/snapshot.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { computeFragilityMetrics } from "./aladdin/fragility.js";
import { AladdinSimulator, CalibrationTracker } from "./aladdin/simulator.js";
import { CausalDiscoveryEngine } from "./causal/lead-lag.js";
import { NewsLinkerEngine } from "./causal/news-linker.js";
import { detectMarketRegime } from "./core/math.js";
import type { FragilityMetrics } from "./core/types.js";
import {
  fetchBinanceKlinesReturns,
  fetchBinancePerpFragilityInputs,
  fetchBinanceSpotQuotes,
  fetchDefiLlamaTopProtocols,
  fetchDeribitDvol,
  fetchGdeltNews,
  fetchMacroFxProxy,
  fetchNasdaqEquityQuote,
  fetchSecRecentFilings,
  fetchStablecoinPegs,
} from "./feeds/live-feeds.js";
import { sendTelegramCascadeAlert } from "./feeds/telegram.js";
import { AutoGraphExpander } from "./graph/auto-discovery.js";
import {
  TemporalKnowledgeGraph,
  type GraphSnapshot,
} from "./graph/temporal-graph.js";

const SNAPSHOT_PATH = resolve(process.cwd(), "data/snapshot.json");

async function runWatchdog(): Promise<void> {
  const graph = new TemporalKnowledgeGraph(true);
  if (existsSync(SNAPSHOT_PATH)) {
    try {
      const raw = JSON.parse(
        readFileSync(SNAPSHOT_PATH, "utf8"),
      ) as GraphSnapshot;
      if (raw.nodes?.length) graph.importSnapshot(raw);
    } catch {
      console.warn("Could not parse existing snapshot, using seed skeleton.");
    }
  }

  const expander = new AutoGraphExpander();
  const causal = new CausalDiscoveryEngine();
  const newsLinker = new NewsLinkerEngine();
  const simulator = new AladdinSimulator();
  const calibration = new CalibrationTracker();

  const equityPairs: Array<[string, string]> = [
    ["EQ_NVDA", "NVDA"],
    ["EQ_QQQ", "QQQ"],
    ["EQ_MSTR", "MSTR"],
    ["EQ_COIN", "COIN"],
    ["EQ_TSMC", "TSM"],
    ["EQ_AMD", "AMD"],
  ];

  const perpSymbols = [
    "BTCUSDT",
    "ETHUSDT",
    "SOLUSDT",
    "RENDERUSDT",
    "TAOUSDT",
  ];

  const [
    quotes,
    eqResults,
    perpResults,
    pegs,
    fx,
    gdelt,
    protocols,
    dvolBtc,
    secFilings,
  ] = await Promise.all([
    fetchBinanceSpotQuotes(),
    Promise.all(
      equityPairs.map(async ([id, sym]) => ({
        id,
        q: await fetchNasdaqEquityQuote(sym),
      })),
    ),
    Promise.all(perpSymbols.map((s) => fetchBinancePerpFragilityInputs(s))),
    fetchStablecoinPegs(),
    fetchMacroFxProxy(),
    fetchGdeltNews(),
    fetchDefiLlamaTopProtocols(15),
    fetchDeribitDvol("BTC"),
    Promise.all([
      fetchSecRecentFilings("EQ_NVDA", "NVDA", "0001045810"),
      fetchSecRecentFilings("EQ_MSTR", "MSTR", "0001050446"),
      fetchSecRecentFilings("EQ_COIN", "COIN", "0001679788"),
    ]),
  ]);

  for (const q of quotes) {
    graph.updateNodeMarketData(q.nodeId, {
      price: q.price,
      change24hPct: q.change24hPct,
    });
  }
  for (const eq of eqResults) {
    if (eq.q) {
      graph.updateNodeMarketData(eq.id, {
        price: eq.q.price,
        change24hPct: eq.q.changePct,
      });
    }
  }
  for (const p of pegs) {
    graph.updateNodeMarketData(p.nodeId, { price: p.price });
  }
  if (fx) {
    graph.updateNodeMarketData("MACRO_DXY", { price: fx.dxyProxy });
  }

  const fragilityMap = new Map<string, FragilityMetrics>();
  let regime = detectMarketRegime(45, 0.01, 0);

  for (const p of perpResults) {
    if (!p) continue;
    const frag = computeFragilityMetrics({
      nodeId: p.nodeId,
      openInterestUsd: p.openInterestUsd,
      spotDepth2PctUsd: p.spotDepth2PctUsd,
      fundingRate8h: p.fundingRate8h,
      longShortRatio: 1.45,
      nearestLiqClusterPct: 2.0,
    });
    fragilityMap.set(p.nodeId, frag);
    graph.updateNodeMarketData(p.nodeId, {
      fragilityScore: frag.fragilityScore,
    });

    if (p.nodeId === "CRYPTO_BTC") {
      const btc = graph.getNode("CRYPTO_BTC");
      regime = detectMarketRegime(
        50,
        p.fundingRate8h * 100,
        btc?.change24hPct ?? 0,
      );
    }
  }

  // Expand graph with DeFiLlama top protocols & GDELT news entities
  const addedProtocols = expander.ingestTopProtocols(graph, protocols);
  let addedNewsNodes = 0;

  const highImpactSims = [];
  for (const [i, art] of gdelt.slice(0, 12).entries()) {
    const ev = newsLinker.analyzeNews(graph, {
      id: `wd_${Date.now()}_${i}`,
      title: art.title,
      source: art.domain || "gdelt",
      url: art.url,
    });
    const exp = expander.discoverFromHeadline(
      graph,
      art.title,
      ev.matchedNodes,
    );
    addedNewsNodes += exp.newNodes.length;
    newsLinker.proposeHypothesesFromNews(graph, ev);

    const sim = simulator.simulateFromNews(graph, ev, fragilityMap, regime);
    if (sim && sim.totalSystemicRiskScore >= 75) {
      highImpactSims.push(sim);
    }
  }

  // Online 15m Lead-Lag discovery
  const klinePairs: Array<[string, string]> = [
    ["CRYPTO_BTC", "BTCUSDT"],
    ["CRYPTO_ETH", "ETHUSDT"],
    ["CRYPTO_SOL", "SOLUSDT"],
    ["CRYPTO_RENDER", "RENDERUSDT"],
    ["CRYPTO_TAO", "TAOUSDT"],
  ];
  const klines = await Promise.all(
    klinePairs.map(
      async ([id, sym]) =>
        [id, await fetchBinanceKlinesReturns(sym, "15m", 96)] as const,
    ),
  );
  const series = new Map<string, number[]>(
    klines.filter(([, r]) => r.length >= 30),
  );
  const discoveries =
    series.size >= 2
      ? causal.discoverLinks(series, { barMinutes: 15, maxLagSteps: 3 })
      : [];
  const syncedEdges = causal.syncDiscoveriesToGraph(graph, discoveries);
  const pruned = graph.pruneWeakEdges(0.45);
  calibration.autoResolveDuePredictions(graph);

  // Check Stablecoin depeg watchdog
  const depegAlert = pegs.find((p) => Math.abs(p.pegDeviationBps) >= 35);
  const tgToken = process.env.TG_BOT_TOKEN ?? "";
  const tgChat = process.env.TG_CHAT_ID ?? "";

  if (tgToken && tgChat) {
    if (depegAlert) {
      const sim = simulator.simulateShock(
        graph,
        {
          triggerNodeId: depegAlert.nodeId,
          shockPct: depegAlert.pegDeviationBps / 100,
          regime: "STRESS_CORRELATION_ONE",
        },
        fragilityMap,
        "STRESS_CORRELATION_ONE",
      );
      await sendTelegramCascadeAlert(tgToken, tgChat, sim);
    } else if (highImpactSims.length > 0) {
      await sendTelegramCascadeAlert(tgToken, tgChat, highImpactSims[0]);
    }
  }

  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(graph.exportSnapshot(), null, 2));

  const secSummary = secFilings
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => `${s.ticker}:Form4(30d)=${s.recentForm4Count30d}`)
    .join(", ");

  console.log(
    `[Watchdog] Nodes=${graph.getAllNodes().length} (+${addedProtocols} proto, +${addedNewsNodes} news) | ` +
      `ActiveEdges=${graph.getActiveEdges().length} (+${syncedEdges} causal, -${pruned} pruned) | ` +
      `Regime=${regime} | DVOL=${dvolBtc?.dvolPct ?? "N/A"}% | SEC=[${secSummary || "N/A"}] | HighRiskAlerts=${highImpactSims.length}`,
  );
}

runWatchdog().catch((err) => {
  console.error("Watchdog error:", err);
  process.exit(1);
});
