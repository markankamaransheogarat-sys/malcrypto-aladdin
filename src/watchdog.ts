/**
 * 24/7 GitHub Actions Watchdog Runner
 * Fetches CORS-free TradFi + Crypto + News + DeFi feeds, expands the Bi-Temporal Graph,
 * runs Granger & Aladdin risk checks, dispatches Telegram alerts, and persists data/snapshot.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  BriefVerdictTracker,
  ExecutiveBriefingEngine,
  type BriefVerdictRecord,
} from "./aladdin/briefing.js";
import { computeFragilityMetrics } from "./aladdin/fragility.js";
import { AladdinSimulator, CalibrationTracker } from "./aladdin/simulator.js";
import { CausalDiscoveryEngine } from "./causal/lead-lag.js";
import { NewsLinkerEngine } from "./causal/news-linker.js";
import { detectMarketRegime } from "./core/math.js";
import type { FragilityMetrics, NewsEvent } from "./core/types.js";
import {
  EventDatabaseStore,
  type StoredMarketEvent,
} from "./feeds/events-db.js";
import {
  fetchBinanceKlinesOhlcv,
  fetchBinanceKlinesReturns,
  fetchBinancePerpFragilityInputs,
  fetchBinanceSpotQuotes,
  fetchCryptoCompareNews,
  fetchDefiLlamaTopProtocols,
  fetchDeribitDvol,
  fetchDeribitOptionsSummary,
  fetchFearAndGreed,
  fetchGdeltNews,
  fetchMacroFxProxy,
  fetchMempoolOnchain,
  fetchNasdaqEquityQuote,
  fetchRssHeadlines,
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
const VERDICTS_PATH = resolve(process.cwd(), "data/verdicts.json");
const EVENTS_DB_PATH = resolve(process.cwd(), "data/events_db.json");

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
    btcOhlcv15m,
    deribitOpt,
    mempool,
    fearGreed,
    ccNews,
    coindeskRss,
    cointelegraphRss,
    fedRss,
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
    fetchBinanceKlinesOhlcv("BTCUSDT", "15m", 192),
    fetchDeribitOptionsSummary("BTC"),
    fetchMempoolOnchain(),
    fetchFearAndGreed(),
    fetchCryptoCompareNews(25),
    fetchRssHeadlines(
      "https://www.coindesk.com/arc/outboundfeeds/rss/",
      "CoinDesk",
      "CRYPTO",
      15,
    ),
    fetchRssHeadlines(
      "https://cointelegraph.com/rss",
      "Cointelegraph",
      "CRYPTO",
      15,
    ),
    fetchRssHeadlines(
      "https://www.federalreserve.gov/feeds/press_all.xml",
      "Federal Reserve",
      "MACRO",
      10,
    ),
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

  // 24/7 Honest Candle-Wick Verdict Tracking (data/verdicts.json)
  const briefTracker = new BriefVerdictTracker();
  if (existsSync(VERDICTS_PATH)) {
    try {
      const saved = JSON.parse(
        readFileSync(VERDICTS_PATH, "utf8"),
      ) as BriefVerdictRecord[];
      if (Array.isArray(saved)) briefTracker.loadRecords(saved);
    } catch {
      // ignore corrupt file
    }
  }
  if (btcOhlcv15m.length > 0) {
    briefTracker.resolveDueVerdictsWithCandles(btcOhlcv15m);
  }
  const btcNode = graph.getNode("CRYPTO_BTC");
  const analyzedNews: NewsEvent[] = [];
  for (const [i, item] of [...ccNews, ...coindeskRss, ...fedRss]
    .slice(0, 20)
    .entries()) {
    analyzedNews.push(
      newsLinker.analyzeNews(graph, {
        id: `wd_feed_${i}_${item.id}`,
        title: item.title,
        source: item.source,
        url: item.url,
      }),
    );
  }
  const briefingEngine = new ExecutiveBriefingEngine();
  const liveBrief = briefingEngine.generate({
    btcPrice: btcNode?.price ?? 71_000,
    btcChange24hPct: btcNode?.change24hPct ?? 0,
    dvolPct: dvolBtc?.dvolPct ?? 42,
    btcFragility: fragilityMap.get("CRYPTO_BTC"),
    fearGreed,
    stablePegs: pegs,
    liq5mLongUsd: 0,
    liq5mShortUsd: 0,
    regime,
    newsFeed: analyzedNews,
    jpyPerUsd: fx?.jpyPerUsd,
    deribitPutCallRatio: deribitOpt?.putCallRatio,
    mempoolFeeSatVb: mempool?.fastestFeeSatVb,
  });
  briefTracker.recordVerdict(liveBrief);
  const verdictStats = briefTracker.getStats();
  writeFileSync(VERDICTS_PATH, JSON.stringify(verdictStats.records, null, 2));

  // Persistent Global Events Database (data/events_db.json)
  const eventsDb = new EventDatabaseStore();
  if (existsSync(EVENTS_DB_PATH)) {
    try {
      const savedEv = JSON.parse(
        readFileSync(EVENTS_DB_PATH, "utf8"),
      ) as StoredMarketEvent[];
      if (Array.isArray(savedEv)) eventsDb.load(savedEv);
    } catch {
      // ignore corrupt file
    }
  }
  const newDbItems: StoredMarketEvent[] = [];
  for (const item of [
    ...ccNews,
    ...coindeskRss,
    ...cointelegraphRss,
    ...fedRss,
  ]) {
    const ev = newsLinker.analyzeNews(graph, {
      id: item.id,
      title: item.title,
      source: item.source,
      url: item.url,
    });
    newDbItems.push({
      id: item.id,
      timestamp: item.publishedAt,
      title: item.title,
      source: item.source,
      category: item.category,
      url: item.url,
      matchedNodes: ev.matchedNodes,
      surpriseScore: Number(ev.surpriseScore.toFixed(2)),
      impact:
        Math.abs(ev.surpriseScore) >= 0.45
          ? "CRITICAL"
          : ev.matchedNodes.length > 0
            ? "HIGH"
            : "MEDIUM",
    });
  }
  for (const art of gdelt.slice(0, 15)) {
    const ev = newsLinker.analyzeNews(graph, {
      id: `gdelt_${art.seendate}_${art.title.slice(0, 24)}`,
      title: art.title,
      source: art.domain || "GDELT",
      url: art.url,
    });
    newDbItems.push({
      id: ev.id,
      timestamp: Date.now(),
      title: art.title,
      source: art.domain || "GDELT",
      category: "MACRO",
      url: art.url,
      matchedNodes: ev.matchedNodes,
      surpriseScore: Number(ev.surpriseScore.toFixed(2)),
      impact: Math.abs(ev.surpriseScore) >= 0.45 ? "CRITICAL" : "HIGH",
    });
  }
  for (const s of secFilings) {
    if (!s || s.recentForm4Count30d === 0) continue;
    newDbItems.push({
      id: `sec_${s.ticker}_${s.latestFiling}`,
      timestamp: Date.now(),
      title: `SEC EDGAR: ${s.ticker} — ${s.recentForm4Count30d} инсайдерских форм Form 4/144 за 30д (последняя: ${s.latestFiling})`,
      source: "SEC EDGAR",
      category: "INSIDER",
      matchedNodes: [s.nodeId],
      surpriseScore: s.recentForm4Count30d >= 5 ? -0.35 : 0.1,
      impact: s.recentForm4Count30d >= 5 ? "HIGH" : "MEDIUM",
    });
  }
  const addedDb = eventsDb.upsertMany(newDbItems);
  writeFileSync(EVENTS_DB_PATH, JSON.stringify(eventsDb.getAll(), null, 2));

  const secSummary = secFilings
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => `${s.ticker}:Form4(30d)=${s.recentForm4Count30d}`)
    .join(", ");

  console.log(
    `[Watchdog] Nodes=${graph.getAllNodes().length} (+${addedProtocols} proto, +${addedNewsNodes} news) | ` +
      `ActiveEdges=${graph.getActiveEdges().length} (+${syncedEdges} causal, -${pruned} pruned) | ` +
      `Regime=${regime} | DVOL=${dvolBtc?.dvolPct ?? "N/A"}% | OptPCR=${deribitOpt?.putCallRatio ?? "N/A"} | ` +
      `Mempool=${mempool?.fastestFeeSatVb ?? "N/A"}sat/vB | Verdicts=${verdictStats.resolved}/${verdictStats.total} | ` +
      `EventsDB=${eventsDb.getAll().length} (+${addedDb}) | SEC=[${secSummary || "N/A"}] | HighRiskAlerts=${highImpactSims.length}`,
  );
}

runWatchdog().catch((err) => {
  console.error("Watchdog error:", err);
  process.exit(1);
});
