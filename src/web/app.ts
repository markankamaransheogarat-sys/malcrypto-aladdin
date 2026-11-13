/**
 * MalCrypto Aladdin — Browser Terminal Controller (Phase 2: Real-Time WS, Multi-Asset Fragility, WebWorker & Backtest)
 */

import { BacktestEngine, type BacktestSummary } from "../aladdin/backtest.js";
import { computeFragilityMetrics } from "../aladdin/fragility.js";
import {
  DEFAULT_PORTFOLIO,
  PortfolioRiskEngine,
  type PortfolioPosition,
} from "../aladdin/portfolio.js";
import { AladdinSimulator, CalibrationTracker } from "../aladdin/simulator.js";
import {
  analyzeWithOpenAICompatible,
  type AiEngineMode,
} from "../causal/ai-adapter.js";
import { CausalDiscoveryEngine } from "../causal/lead-lag.js";
import { NewsLinkerEngine } from "../causal/news-linker.js";
import { detectMarketRegime } from "../core/math.js";
import type {
  CausalDiscoveryResult,
  FragilityMetrics,
  MarketRegime,
  NewsEvent,
  SimulationResult,
} from "../core/types.js";
import {
  fetchBinanceKlinesReturns,
  fetchBinancePerpFragilityInputs,
  fetchBinanceSpotQuotes,
  fetchDefiLlamaGlobalTvl,
  fetchDefiLlamaTopProtocols,
  fetchDeribitDvol,
  fetchFearAndGreed,
  fetchGdeltNews,
  fetchMacroFxProxy,
  fetchNasdaqEquityQuote,
  fetchPolymarketTopSignals,
  fetchStablecoinPegs,
  type MacroFxSnapshot,
  type PolymarketSignal,
  type StablecoinPegQuote,
} from "../feeds/live-feeds.js";
import { sendTelegramCascadeAlert } from "../feeds/telegram.js";
import { LiveWebSocketHub } from "../feeds/ws-stream.js";
import { AutoGraphExpander } from "../graph/auto-discovery.js";
import { idbStore } from "../graph/idb-store.js";
import {
  TemporalKnowledgeGraph,
  type GraphSnapshot,
} from "../graph/temporal-graph.js";
import { MaltegoGraphCanvas } from "./graph-canvas.js";

type TabId =
  | "GRAPH"
  | "RADAR"
  | "CAUSAL"
  | "WIRE"
  | "CASCADE"
  | "CALIB"
  | "BACKTEST"
  | "PORTFOLIO";

const SYMBOL_TO_NODE: Record<string, string> = {
  BTCUSDT: "CRYPTO_BTC",
  ETHUSDT: "CRYPTO_ETH",
  SOLUSDT: "CRYPTO_SOL",
  RENDERUSDT: "CRYPTO_RENDER",
  TAOUSDT: "CRYPTO_TAO",
  FETUSDT: "CRYPTO_FET",
  LINKUSDT: "CRYPTO_LINK",
};

class MalCryptoApp {
  private graph = new TemporalKnowledgeGraph(true);
  private expander = new AutoGraphExpander();
  private causal = new CausalDiscoveryEngine();
  private newsLinker = new NewsLinkerEngine();
  private simulator = new AladdinSimulator();
  private calibration = new CalibrationTracker();
  private backtest = new BacktestEngine();
  private portfolioEngine = new PortfolioRiskEngine();
  private portfolio: PortfolioPosition[] = [...DEFAULT_PORTFOLIO];
  private dvolBtcPct = 45;
  private backtestSummary: BacktestSummary | null = null;
  private aiWorker: Worker | null = null;
  private aiMode: AiEngineMode = "ALGORITHMIC";
  private aiReady = false;

  private fragilityMap = new Map<string, FragilityMetrics>();
  private discoveries: CausalDiscoveryResult[] = [];
  private newsFeed: NewsEvent[] = [];
  private polymarket: PolymarketSignal[] = [];
  private stablePegs: StablecoinPegQuote[] = [];
  private macroFx: MacroFxSnapshot | null = null;
  private fearGreed: { value: number; classification: string } | null = null;
  private wsConnected = false;

  private currentRegime: MarketRegime = "EUPHORIA_OVERLEVERAGED";
  private activeSim: SimulationResult | null = null;
  private selectedNodeId: string | null = "ACTOR_HUANG";
  private activeTab: TabId = "GRAPH";
  private canvasRenderer: MaltegoGraphCanvas | null = null;
  private wsHub: LiveWebSocketHub | null = null;
  private tvlUsd = 0;
  private lastUiRenderMs = 0;

  async init(): Promise<void> {
    const savedSnap = await idbStore.loadGraphSnapshot();
    if (savedSnap && savedSnap.nodes.length > 0) {
      this.graph.importSnapshot(savedSnap);
    }
    // Hydrate from 24/7 GitHub Actions Watchdog snapshot if newer
    try {
      const res = await fetch("./data/snapshot.json", {
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const remoteSnap = (await res.json()) as GraphSnapshot;
        if (
          remoteSnap.nodes?.length &&
          (!savedSnap || remoteSnap.exportedAt > savedSnap.exportedAt)
        ) {
          this.graph.importSnapshot(remoteSnap);
        }
      }
    } catch {
      // No remote snapshot yet
    }
    const savedNews = await idbStore.loadNews();
    if (savedNews) this.newsFeed = savedNews;
    const savedPreds = await idbStore.loadPredictions();
    if (savedPreds) {
      for (const p of savedPreds) this.calibration.recordPrediction(p);
    }
    const savedPort = await idbStore.loadPortfolio();
    if (savedPort && savedPort.length > 0) this.portfolio = savedPort;

    const canvasEl = document.getElementById(
      "graph-canvas",
    ) as HTMLCanvasElement | null;
    if (canvasEl) {
      this.canvasRenderer = new MaltegoGraphCanvas(canvasEl, (nodeId) => {
        this.selectedNodeId = nodeId;
        this.renderNodeInspector();
      });
      this.canvasRenderer.setData(
        this.graph.getAllNodes(),
        this.graph.getActiveEdges(),
      );
    }

    this.bindUI();
    this.backtestSummary = this.backtest.runHistoricalSuite(this.graph);
    this.runDefaultHuangDemo();
    this.startWebSockets();
    this.renderAll();

    void this.refreshLiveFeeds();
  }

  private startWebSockets(): void {
    this.wsHub = new LiveWebSocketHub({
      onStatus: (connected) => {
        this.wsConnected = connected;
        this.renderHeaderMetrics();
      },
      onTicker: (t) => {
        const nodeId = SYMBOL_TO_NODE[t.symbol];
        if (!nodeId) return;
        this.graph.updateNodeMarketData(nodeId, {
          price: t.price,
          change24hPct: t.change24hPct,
        });
        const now = performance.now();
        if (now - this.lastUiRenderMs > 800) {
          this.lastUiRenderMs = now;
          this.renderHeaderMetrics();
        }
      },
      onLiquidation: () => {
        const now = performance.now();
        if (now - this.lastUiRenderMs > 1200) {
          this.lastUiRenderMs = now;
          this.renderHeaderMetrics();
          if (this.activeTab === "RADAR") this.renderRadar();
        }
      },
    });
    this.wsHub.start();
  }

  private runDefaultHuangDemo(): void {
    this.activeSim = this.simulator.simulateShock(
      this.graph,
      {
        triggerNodeId: "ACTOR_HUANG",
        shockPct: -9.5,
        regime: this.currentRegime,
      },
      this.fragilityMap,
      this.currentRegime,
    );
    this.canvasRenderer?.setSimulation(this.activeSim);
  }

  async refreshLiveFeeds(): Promise<void> {
    this.setStatus(
      "Syncing Zero-Key Feeds (Binance Perps, DeFiLlama, Frankfurter FX, Polymarket, GDELT)...",
    );

    const perpSymbols = [
      "BTCUSDT",
      "ETHUSDT",
      "SOLUSDT",
      "RENDERUSDT",
      "TAOUSDT",
    ];
    const equityPairs: Array<[string, string]> = [
      ["EQ_NVDA", "NVDA"],
      ["EQ_QQQ", "QQQ"],
      ["EQ_MSTR", "MSTR"],
      ["EQ_COIN", "COIN"],
    ];

    const [quotes, perpResults, poly, gdelt, tvl, pegs, fx, fng, eqResults] =
      await Promise.all([
        fetchBinanceSpotQuotes(),
        Promise.all(perpSymbols.map((s) => fetchBinancePerpFragilityInputs(s))),
        fetchPolymarketTopSignals(),
        fetchGdeltNews(),
        fetchDefiLlamaGlobalTvl(),
        fetchStablecoinPegs(),
        fetchMacroFxProxy(),
        fetchFearAndGreed(),
        Promise.all(
          equityPairs.map(async ([nodeId, sym]) => ({
            nodeId,
            q: await fetchNasdaqEquityQuote(sym),
          })),
        ),
      ]);

    for (const q of quotes) {
      this.graph.updateNodeMarketData(q.nodeId, {
        price: q.price,
        change24hPct: q.change24hPct,
      });
    }

    for (const eq of eqResults) {
      if (eq.q) {
        this.graph.updateNodeMarketData(eq.nodeId, {
          price: eq.q.price,
          change24hPct: eq.q.changePct,
        });
      }
    }

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
      this.fragilityMap.set(p.nodeId, frag);
      this.graph.updateNodeMarketData(p.nodeId, {
        fragilityScore: frag.fragilityScore,
      });

      if (p.nodeId === "CRYPTO_BTC") {
        const btcNode = this.graph.getNode("CRYPTO_BTC");
        this.currentRegime = detectMarketRegime(
          50,
          p.fundingRate8h * 100,
          btcNode?.change24hPct ?? 0,
        );
      }
    }

    if (tvl) this.tvlUsd = tvl.totalTvlUsd;
    if (pegs.length > 0) {
      this.stablePegs = pegs;
      for (const peg of pegs) {
        this.graph.updateNodeMarketData(peg.nodeId, { price: peg.price });
      }
    }
    if (fx) {
      this.macroFx = fx;
      this.graph.updateNodeMarketData("MACRO_DXY", { price: fx.dxyProxy });
    }
    if (fng) this.fearGreed = fng;
    if (poly.length > 0) this.polymarket = poly;

    if (gdelt.length > 0) {
      const parsed: NewsEvent[] = gdelt.map((art, i) => {
        const ev = this.newsLinker.analyzeNews(this.graph, {
          id: `gdelt_${Date.now()}_${i}`,
          title: art.title,
          source: art.domain || "gdelt",
          url: art.url,
        });
        this.expander.discoverFromHeadline(
          this.graph,
          art.title,
          ev.matchedNodes,
        );
        this.newsLinker.proposeHypothesesFromNews(this.graph, ev);
        return ev;
      });
      this.newsFeed = [...parsed, ...this.newsFeed].slice(0, 60);
      await idbStore.saveNews(this.newsFeed);
    }

    // Autonomous DeFiLlama top protocol discovery & Deribit DVOL
    const [topProtos, dvol] = await Promise.all([
      fetchDefiLlamaTopProtocols(12),
      fetchDeribitDvol("BTC"),
    ]);
    if (topProtos.length > 0) {
      this.expander.ingestTopProtocols(this.graph, topProtos);
    }
    if (dvol) this.dvolBtcPct = dvol.dvolPct;

    await this.runOnlineCausalScan();
    this.calibration.autoResolveDuePredictions(this.graph);

    this.backtestSummary = this.backtest.runHistoricalSuite(this.graph);
    this.canvasRenderer?.setData(
      this.graph.getAllNodes(),
      this.graph.getActiveEdges(),
    );
    await idbStore.saveGraphSnapshot(this.graph.exportSnapshot());

    this.setStatus(
      `LIVE • ${this.graph.getAllNodes().length} Nodes • ${this.graph.getActiveEdges().length} Edges • Regime: ${this.currentRegime}`,
    );
    this.renderAll();
  }

  async runOnlineCausalScan(): Promise<void> {
    const pairs: Array<[string, string]> = [
      ["CRYPTO_BTC", "BTCUSDT"],
      ["CRYPTO_ETH", "ETHUSDT"],
      ["CRYPTO_SOL", "SOLUSDT"],
      ["CRYPTO_RENDER", "RENDERUSDT"],
      ["CRYPTO_TAO", "TAOUSDT"],
      ["CRYPTO_FET", "FETUSDT"],
      ["CRYPTO_LINK", "LINKUSDT"],
    ];

    const results = await Promise.all(
      pairs.map(async ([nodeId, sym]) => ({
        nodeId,
        ret: await fetchBinanceKlinesReturns(sym, "15m", 96),
      })),
    );

    const entries: Array<[string, number[]]> = [];
    for (const r of results) {
      if (r.ret.length >= 30) entries.push([r.nodeId, r.ret]);
    }
    if (entries.length < 2) return;

    this.discoveries = await this.runDiscoveryInWorker(entries);
    this.causal.syncDiscoveriesToGraph(this.graph, this.discoveries);
  }

  private runDiscoveryInWorker(
    entries: Array<[string, number[]]>,
  ): Promise<CausalDiscoveryResult[]> {
    if (typeof Worker === "undefined") {
      return Promise.resolve(
        this.causal.discoverLinks(new Map(entries), {
          barMinutes: 15,
          maxLagSteps: 4,
          fdrAlpha: 0.05,
        }),
      );
    }

    return new Promise((resolve) => {
      try {
        const worker = new Worker("./dist/causal-worker.js", {
          type: "module",
        });
        const reqId = Date.now();
        const timer = setTimeout(() => {
          worker.terminate();
          resolve(
            this.causal.discoverLinks(new Map(entries), {
              barMinutes: 15,
              maxLagSteps: 4,
              fdrAlpha: 0.05,
            }),
          );
        }, 5000);

        worker.onmessage = (
          ev: MessageEvent<{
            id: number;
            discoveries: CausalDiscoveryResult[];
          }>,
        ) => {
          if (ev.data.id === reqId) {
            clearTimeout(timer);
            worker.terminate();
            resolve(ev.data.discoveries);
          }
        };
        worker.onerror = () => {
          clearTimeout(timer);
          worker.terminate();
          resolve(
            this.causal.discoverLinks(new Map(entries), {
              barMinutes: 15,
              maxLagSteps: 4,
              fdrAlpha: 0.05,
            }),
          );
        };
        worker.postMessage({
          id: reqId,
          entries,
          barMinutes: 15,
          maxLagSteps: 4,
          fdrAlpha: 0.05,
        });
      } catch {
        resolve(
          this.causal.discoverLinks(new Map(entries), {
            barMinutes: 15,
            maxLagSteps: 4,
            fdrAlpha: 0.05,
          }),
        );
      }
    });
  }

  private bindUI(): void {
    document
      .querySelectorAll<HTMLButtonElement>("[data-tab]")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          this.switchTab(btn.dataset.tab as TabId);
        });
      });

    window.addEventListener("keydown", (e) => {
      const map: Record<string, TabId> = {
        F1: "GRAPH",
        F2: "RADAR",
        F3: "CAUSAL",
        F4: "WIRE",
        F5: "CASCADE",
        F6: "CALIB",
        F7: "BACKTEST",
        F8: "PORTFOLIO",
      };
      if (map[e.key]) {
        e.preventDefault();
        this.switchTab(map[e.key]);
      }
    });

    document.getElementById("btn-refresh")?.addEventListener("click", () => {
      void this.refreshLiveFeeds();
    });

    document.getElementById("btn-run-sim")?.addEventListener("click", () => {
      const trigger = (
        document.getElementById("sim-trigger") as HTMLSelectElement
      ).value;
      const shockPct = Number(
        (document.getElementById("sim-shock") as HTMLInputElement).value,
      );
      const regime = (
        document.getElementById("sim-regime") as HTMLSelectElement
      ).value as MarketRegime;
      this.currentRegime = regime;
      this.activeSim = this.simulator.simulateShock(
        this.graph,
        { triggerNodeId: trigger, shockPct, regime },
        this.fragilityMap,
        regime,
      );
      this.canvasRenderer?.setSimulation(this.activeSim);
      this.recordSimPrediction(this.activeSim);
      this.renderAll();
    });

    document.getElementById("ai-mode")?.addEventListener("change", (e) => {
      this.aiMode = (e.target as HTMLSelectElement).value as AiEngineMode;
      const st = document.getElementById("ai-status");
      if (st) st.textContent = `AI: ${this.aiMode}`;
    });

    document.getElementById("btn-init-ai")?.addEventListener("click", () => {
      const st = document.getElementById("ai-status");
      if (typeof Worker === "undefined") return;
      if (st)
        st.textContent = "AI: Downloading ONNX models to browser cache...";
      this.aiWorker = new Worker("./dist/ai-worker.js", { type: "module" });
      this.aiWorker.onmessage = (
        ev: MessageEvent<{
          ok: boolean;
          type?: string;
          backend?: string;
          error?: string;
        }>,
      ) => {
        if (ev.data.type === "INIT") {
          this.aiReady = ev.data.ok;
          if (ev.data.ok) {
            this.aiMode = "WEBGPU_LOCAL";
            const sel = document.getElementById(
              "ai-mode",
            ) as HTMLSelectElement | null;
            if (sel) sel.value = "WEBGPU_LOCAL";
            if (st)
              st.textContent = `AI: READY (${ev.data.backend?.toUpperCase() ?? "WASM"})`;
          } else if (st) {
            st.textContent = `AI Error: ${ev.data.error ?? "failed"}`;
          }
        }
      };
      this.aiWorker.postMessage({ type: "INIT", id: Date.now() });
    });

    document
      .getElementById("btn-parse-news")
      ?.addEventListener("click", async () => {
        const titleEl = document.getElementById(
          "custom-news-input",
        ) as HTMLInputElement;
        const priorEl = document.getElementById(
          "custom-news-prior",
        ) as HTMLInputElement;
        const text = titleEl.value.trim();
        if (!text) return;

        const prior = Number(priorEl.value || 0.7);
        const ev = this.newsLinker.analyzeNews(this.graph, {
          id: `manual_${Date.now()}`,
          title: text,
          source: "Reuters",
          marketPriorPositiveProb: prior,
        });

        // Enhance with Mode 2 (WebGPU/WASM) or Mode 1 (Ollama/OpenAI) if enabled
        if (this.aiMode === "WEBGPU_LOCAL" && this.aiWorker && this.aiReady) {
          const aiRes = await this.analyzeWithBrowserWorker(text);
          if (aiRes) {
            ev.sentiment = aiRes.sentiment;
            ev.category = aiRes.category;
            ev.surpriseScore = Number(
              Math.max(
                -1,
                Math.min(1, aiRes.sentiment - (prior - 0.5) * 1.3),
              ).toFixed(2),
            );
          }
        } else if (this.aiMode === "OLLAMA_OPENAI") {
          const endpoint = (
            document.getElementById("ai-endpoint") as HTMLInputElement
          )?.value;
          const aiRes = await analyzeWithOpenAICompatible(text, {
            mode: "OLLAMA_OPENAI",
            endpointUrl: endpoint,
          });
          if (aiRes) {
            ev.sentiment = aiRes.sentiment;
            ev.category = aiRes.category;
            ev.surpriseScore = Number(
              Math.max(
                -1,
                Math.min(1, aiRes.sentiment - (prior - 0.5) * 1.3),
              ).toFixed(2),
            );
          }
        }

        this.expander.discoverFromHeadline(this.graph, text, ev.matchedNodes);
        this.newsFeed.unshift(ev);
        this.newsLinker.proposeHypothesesFromNews(this.graph, ev);

        const sim = this.simulator.simulateFromNews(
          this.graph,
          ev,
          this.fragilityMap,
          this.currentRegime,
        );
        if (sim) {
          this.activeSim = sim;
          this.canvasRenderer?.setSimulation(sim);
          this.recordSimPrediction(sim);
        }
        this.canvasRenderer?.setData(
          this.graph.getAllNodes(),
          this.graph.getActiveEdges(),
        );
        void idbStore.saveGraphSnapshot(this.graph.exportSnapshot());
        void idbStore.saveNews(this.newsFeed);
        titleEl.value = "";
        this.renderAll();
      });

    document
      .getElementById("btn-send-tg")
      ?.addEventListener("click", async () => {
        if (!this.activeSim) return;
        const token = (
          document.getElementById("tg-token") as HTMLInputElement
        ).value.trim();
        const chatId = (
          document.getElementById("tg-chat") as HTMLInputElement
        ).value.trim();
        const ok = await sendTelegramCascadeAlert(
          token,
          chatId,
          this.activeSim,
        );
        this.setStatus(
          ok
            ? "Telegram Cascade Alert Sent!"
            : "Telegram Send Failed (check token/chat)",
        );
      });

    document.getElementById("btn-prune")?.addEventListener("click", () => {
      const pruned = this.graph.pruneWeakEdges(0.5);
      this.canvasRenderer?.setData(
        this.graph.getAllNodes(),
        this.graph.getActiveEdges(),
      );
      this.setStatus(`Pruned ${pruned} weak hypothesis edges.`);
      this.renderAll();
    });

    document
      .getElementById("btn-export-snap")
      ?.addEventListener("click", () => {
        const snap = JSON.stringify(this.graph.exportSnapshot(), null, 2);
        const blob = new Blob([snap], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `malcrypto-graph-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(url);
      });

    document.getElementById("btn-port-add")?.addEventListener("click", () => {
      const nodeEl = document.getElementById("port-node") as HTMLSelectElement;
      const usdEl = document.getElementById("port-usd") as HTMLInputElement;
      const nodeId = nodeEl.value;
      const usd = Math.max(0, Number(usdEl.value || 0));
      const label = nodeEl.options[nodeEl.selectedIndex]?.text ?? nodeId;
      const idx = this.portfolio.findIndex((p) => p.nodeId === nodeId);
      if (usd === 0 && idx >= 0) {
        this.portfolio.splice(idx, 1);
      } else if (idx >= 0) {
        this.portfolio[idx] = { nodeId, label, allocationUsd: usd };
      } else if (usd > 0) {
        this.portfolio.push({ nodeId, label, allocationUsd: usd });
      }
      void idbStore.savePortfolio(this.portfolio);
      this.renderPortfolio();
    });

    document.getElementById("btn-port-reset")?.addEventListener("click", () => {
      this.portfolio = [...DEFAULT_PORTFOLIO];
      void idbStore.savePortfolio(this.portfolio);
      this.renderPortfolio();
    });
  }

  private analyzeWithBrowserWorker(
    text: string,
  ): Promise<{ sentiment: number; category: NewsEvent["category"] } | null> {
    if (!this.aiWorker || !this.aiReady) return Promise.resolve(null);
    return new Promise((resolve) => {
      const reqId = Date.now();
      const timer = setTimeout(() => resolve(null), 8000);
      const handler = (
        ev: MessageEvent<{
          id: number;
          ok: boolean;
          type?: string;
          sentiment?: number;
          category?: NewsEvent["category"];
        }>,
      ) => {
        if (ev.data.id === reqId && ev.data.type === "ANALYZE") {
          clearTimeout(timer);
          this.aiWorker?.removeEventListener("message", handler);
          if (ev.data.ok && ev.data.sentiment !== undefined) {
            resolve({
              sentiment: ev.data.sentiment,
              category: ev.data.category ?? "NARRATIVE",
            });
          } else {
            resolve(null);
          }
        }
      };
      this.aiWorker!.addEventListener("message", handler);
      this.aiWorker!.postMessage({ type: "ANALYZE", id: reqId, text });
    });
  }

  private recordSimPrediction(sim: SimulationResult): void {
    const cascade = sim.scenarios.find((s) => s.name === "CASCADE_CRASH");
    const btcNode = sim.affectedNodes.find((n) => n.nodeId === "CRYPTO_BTC");
    if (!cascade || !btcNode) return;
    const liveBtcPrice = this.graph.getNode("CRYPTO_BTC")?.price;
    this.calibration.recordPrediction({
      id: `pred_${sim.id}`,
      createdAt: sim.timestamp,
      targetNodeId: "CRYPTO_BTC",
      triggerNodeId: sim.triggerNodeId,
      predictedCrashProb: cascade.probability,
      predictedMovePct: btcNode.expectedMovePct,
      horizonHours: 12,
      thresholdPct: sim.shockPct < 0 ? -4 : 4,
      baselinePrice: liveBtcPrice,
    });
    void idbStore.savePredictions(this.calibration.getRecords());
  }

  private switchTab(tab: TabId): void {
    this.activeTab = tab;
    document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll<HTMLElement>(".tab-panel").forEach((p) => {
      p.classList.toggle("hidden", p.id !== `panel-${tab}`);
    });
    if (tab === "GRAPH") {
      this.canvasRenderer?.resize();
    }
  }

  private setStatus(msg: string): void {
    const el = document.getElementById("status-line");
    if (el) el.textContent = msg;
  }

  private renderAll(): void {
    this.renderHeaderMetrics();
    this.renderNodeInspector();
    this.renderRadar();
    this.renderCausal();
    this.renderWire();
    this.renderCascade();
    this.renderCalib();
    this.renderBacktest();
    this.renderPortfolio();
  }

  private renderHeaderMetrics(): void {
    const btc = this.graph.getNode("CRYPTO_BTC");
    const btcFrag = this.fragilityMap.get("CRYPTO_BTC");
    const liqStats = this.wsHub?.getLiquidationStats(5 * 60 * 1000);
    const el = document.getElementById("header-kpis");
    if (!el) return;
    el.innerHTML = `
      <span>${this.wsConnected ? '<b class="pos">● WS</b>' : '<b class="muted">○ WS</b>'}</span>
      <span>BTC: <b>${btc?.price ? "$" + btc.price.toLocaleString(undefined, { maximumFractionDigits: 0 }) : "Syncing"}</b></span>
      <span>DVOL: <b class="gold">${this.dvolBtcPct}%</b></span>
      <span>FRAGILITY: <b class="${btcFrag?.status === "TINDERBOX" ? "neg" : "gold"}">${btcFrag?.fragilityScore ?? "—"}/100</b></span>
      <span>5m LIQS: <b class="neg">${liqStats ? "$" + (liqStats.totalUsd / 1e3).toFixed(0) + "K" : "$0"}</b></span>
      <span>F&amp;G: <b class="cyan">${this.fearGreed ? `${this.fearGreed.value} (${this.fearGreed.classification})` : "—"}</b></span>
      <span>USD/JPY: <b>${this.macroFx ? this.macroFx.jpyPerUsd.toFixed(1) : "—"}</b></span>
      <span>DEFI TVL: <b>${this.tvlUsd ? "$" + (this.tvlUsd / 1e9).toFixed(1) + "B" : "—"}</b></span>
    `;
  }

  private renderNodeInspector(): void {
    const el = document.getElementById("node-inspector");
    if (!el || !this.selectedNodeId) return;
    const node = this.graph.getNode(this.selectedNodeId);
    if (!node) return;
    const outgoing = this.graph.getOutgoingEdges(node.id);
    const incoming = this.graph.getIncomingEdges(node.id);
    const simHit = this.activeSim?.affectedNodes.find(
      (a) => a.nodeId === node.id,
    );

    el.innerHTML = `
      <div class="insp-title">${node.label} <span class="badge">${node.tier}</span></div>
      <div class="insp-sub">${node.sector} • Systemic: ${(node.systemicWeight * 100).toFixed(0)}% ${node.price ? `• $${node.price.toLocaleString()}` : ""}</div>
      ${node.description ? `<p class="insp-desc">${node.description}</p>` : ""}
      ${
        simHit
          ? `<div class="insp-impact ${simHit.expectedMovePct < 0 ? "neg" : "pos"}">
        Simulated Impact: <b>${simHit.expectedMovePct}%</b> (Hop ${simHit.hop}, ~${simHit.etaMinutes}m)<br/>
        Range: [P10: ${simHit.p10MovePct}% .. P90: ${simHit.p90MovePct}%]
      </div>`
          : ""
      }
      <div class="insp-sec">Outgoing Influence (${outgoing.length})</div>
      <ul class="insp-list">
        ${outgoing.map((e) => `<li>→ <b>${e.target}</b> (${e.relation}, w=${e.weight}, lag=${e.lagMinutes}m)</li>`).join("")}
      </ul>
      <div class="insp-sec">Incoming Dependencies (${incoming.length})</div>
      <ul class="insp-list">
        ${incoming.map((e) => `<li>← <b>${e.source}</b> (${e.relation}, w=${e.weight})</li>`).join("")}
      </ul>
    `;
  }

  private renderRadar(): void {
    const el = document.getElementById("radar-content");
    if (!el) return;

    const fragRows = Array.from(this.fragilityMap.values())
      .map(
        (f) => `
      <tr>
        <td><b>${f.nodeId}</b></td>
        <td>$${(f.openInterestUsd / 1e9).toFixed(2)}B</td>
        <td>$${(f.spotDepth2PctUsd / 1e6).toFixed(1)}M</td>
        <td>${f.oiToDepthRatio}x</td>
        <td>${(f.fundingRate8h * 100).toFixed(4)}%</td>
        <td><span class="badge ${f.status === "TINDERBOX" ? "neg-bg" : "gold-bg"}">${f.fragilityScore}/100 ${f.status}</span></td>
      </tr>`,
      )
      .join("");

    const pegBadges = this.stablePegs
      .map(
        (p) =>
          `<div class="poly-pill"><span>${p.symbol} Peg</span><b>$${p.price.toFixed(4)} (${p.pegDeviationBps > 0 ? "+" : ""}${p.pegDeviationBps} bps)</b></div>`,
      )
      .join("");

    const liqStats = this.wsHub?.getLiquidationStats(5 * 60 * 1000);
    const liqRows = (liqStats?.recent ?? [])
      .slice(0, 6)
      .map(
        (l) =>
          `<tr><td>${l.symbol}</td><td class="${l.side === "SELL" ? "neg" : "pos"}">${l.side === "SELL" ? "LONG LIQ" : "SHORT LIQ"}</td><td>$${l.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td>$${l.price}</td></tr>`,
      )
      .join("");

    const scenRows =
      this.activeSim?.scenarios
        .map(
          (s) => `
      <div class="scen-card">
        <div class="scen-head"><span>${s.label}</span><b>${(s.probability * 100).toFixed(0)}%</b></div>
        <div class="scen-btc ${s.btcExpectedPct < 0 ? "neg" : "pos"}">BTC: ${s.btcExpectedPct > 0 ? "+" : ""}${s.btcExpectedPct}% (${s.horizonHours}h)</div>
        <div class="scen-cond">${s.triggerCondition}</div>
      </div>`,
        )
        .join("") ?? "";

    el.innerHTML = `
      <div class="poly-strip">${pegBadges}</div>
      <h3>Live Multi-Asset Perp Fragility ("Tinderbox" Radar)</h3>
      <table class="data-table">
        <thead><tr><th>Node</th><th>Open Interest</th><th>±2% Depth</th><th>OI/Depth</th><th>Funding 8h</th><th>Fragility</th></tr></thead>
        <tbody>${fragRows || '<tr><td colspan="6" class="muted">Syncing live Binance Perp metrics...</td></tr>'}</tbody>
      </table>
      <h3 style="margin-top:18px;">Active Scenario Tree — Trigger: ${this.activeSim?.triggerLabel ?? "None"} (${this.activeSim?.shockPct ?? 0}%)</h3>
      <div class="scen-grid">${scenRows}</div>
      <h3 style="margin-top:18px;">Live Forced Liquidations Stream (5m Window: $${((liqStats?.totalUsd ?? 0) / 1e3).toFixed(1)}K)</h3>
      <table class="data-table">
        <thead><tr><th>Symbol</th><th>Side</th><th>Notional</th><th>Price</th></tr></thead>
        <tbody>${liqRows || '<tr><td colspan="4" class="muted">Listening to Binance Futures !forceOrder@arr WebSocket...</td></tr>'}</tbody>
      </table>
    `;
  }

  private renderCausal(): void {
    const el = document.getElementById("causal-content");
    if (!el) return;
    if (this.discoveries.length === 0) {
      el.innerHTML = `<p class="muted">Running off-main-thread WebWorker Granger & Tail-Beta scan on live 15m klines...</p>`;
      return;
    }
    const rows = this.discoveries
      .slice(0, 20)
      .map(
        (d) => `
      <tr>
        <td><b>${d.source}</b> → <b>${d.target}</b></td>
        <td>${d.lagMinutes}m</td>
        <td>${d.correlation}</td>
        <td>${d.tailBetaDownside}</td>
        <td>${d.grangerFStat}</td>
        <td>${d.pValue}</td>
        <td>${d.fdrSignificant ? '<span class="pos">FDR PASS</span>' : '<span class="muted">PRUNED</span>'}</td>
      </tr>`,
      )
      .join("");

    el.innerHTML = `
      <table class="data-table">
        <thead><tr><th>Directed Pair</th><th>Lag</th><th>Corr</th><th>Tail Beta (>1.5σ)</th><th>Granger F</th><th>p-value</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderWire(): void {
    const el = document.getElementById("wire-content");
    if (!el) return;

    const polyHtml = this.polymarket
      .slice(0, 5)
      .map(
        (p) =>
          `<div class="poly-pill"><span>${p.question}</span><b>YES ${(p.yesProbability * 100).toFixed(0)}%</b></div>`,
      )
      .join("");

    const newsHtml =
      this.newsFeed.length > 0
        ? this.newsFeed
            .slice(0, 25)
            .map(
              (n) => `
        <div class="news-item">
          <div class="news-meta">
            <span class="badge">${n.status}</span>
            <span>${n.source} (Trust ${(n.trustScore * 100).toFixed(0)}%)</span>
            <span>Cat: ${n.category}</span>
            <span class="${n.surpriseScore < 0 ? "neg" : "pos"}">Surprise: ${n.surpriseScore}</span>
          </div>
          <div class="news-title">${n.title}</div>
          <div class="news-nodes">Nodes: ${n.matchedNodes.length ? n.matchedNodes.join(", ") : "None matched"}</div>
        </div>`,
            )
            .join("")
        : '<p class="muted">No live news fetched yet. Paste a headline above or click Sync Live Feeds.</p>';

    el.innerHTML = `
      <div class="poly-strip">${polyHtml}</div>
      <div class="news-list">${newsHtml}</div>
    `;
  }

  private renderCascade(): void {
    const el = document.getElementById("cascade-content");
    if (!el || !this.activeSim) return;

    const rows = this.activeSim.affectedNodes
      .map(
        (n) => `
      <tr>
        <td>Hop ${n.hop}</td>
        <td><b>${n.label}</b></td>
        <td>~${n.etaMinutes}m</td>
        <td class="${n.expectedMovePct < 0 ? "neg" : "pos"}"><b>${n.expectedMovePct > 0 ? "+" : ""}${n.expectedMovePct}%</b></td>
        <td>${n.p10MovePct}% .. ${n.p90MovePct}%</td>
        <td>${n.fragilityAmplifier}x</td>
        <td class="muted">${n.path.join(" → ")}</td>
      </tr>`,
      )
      .join("");

    el.innerHTML = `
      <div class="sim-summary">
        Trigger: <b>${this.activeSim.triggerLabel}</b> (${this.activeSim.shockPct}%) |
        Systemic Risk Score: <b class="neg">${this.activeSim.totalSystemicRiskScore}/100</b> |
        Max Depth: <b>${this.activeSim.maxCascadeDepth} hops</b>
      </div>
      <table class="data-table">
        <thead><tr><th>Hop</th><th>Asset / Node</th><th>ETA</th><th>Expected</th><th>P10..P90</th><th>Fragility Amp</th><th>Contagion Path</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderCalib(): void {
    const el = document.getElementById("calib-content");
    if (!el) return;
    const rep = this.calibration.getReport();
    el.innerHTML = `
      <div class="calib-cards">
        <div class="c-card"><span>Total Predictions</span><b>${rep.totalPredictions}</b></div>
        <div class="c-card"><span>Resolved</span><b>${rep.resolvedCount}</b></div>
        <div class="c-card"><span>Brier Score (0=Best)</span><b>${rep.brierScore}</b></div>
        <div class="c-card"><span>Hit Rate</span><b>${(rep.hitRate * 100).toFixed(1)}%</b></div>
      </div>
    `;
  }

  private renderBacktest(): void {
    const el = document.getElementById("backtest-content");
    if (!el || !this.backtestSummary) return;
    const s = this.backtestSummary;

    const rows = s.cases
      .map(
        (c) => `
      <tr>
        <td><b>${c.name}</b><br/><span class="muted">${c.dateLabel} • ${c.triggerNodeId} (${c.shockPct}%)</span></td>
        <td class="${c.predictedBtcPct < 0 ? "neg" : "pos"}">${c.predictedBtcPct}%</td>
        <td class="neg">${c.actualBtcPct ? c.actualBtcPct + "%" : "N/A"}</td>
        <td>${(c.predictedCrashProb * 100).toFixed(0)}% (Actual: ${c.actualCrashOccurred})</td>
        <td>${c.directionalHits}/${c.directionalTotal}</td>
        <td>${c.intervalHits}/${c.directionalTotal}</td>
        <td>${c.maePct}%</td>
      </tr>`,
      )
      .join("");

    el.innerHTML = `
      <div class="calib-cards" style="margin-bottom:16px;">
        <div class="c-card"><span>Historical Brier Score</span><b>${s.overallBrierScore}</b></div>
        <div class="c-card"><span>Directional Accuracy</span><b>${(s.overallDirectionalAccuracy * 100).toFixed(1)}%</b></div>
        <div class="c-card"><span>P10..P90 Band Coverage</span><b>${(s.overallIntervalCoverage * 100).toFixed(1)}%</b></div>
        <div class="c-card"><span>Mean Abs Error</span><b>${s.overallMaePct}%</b></div>
      </div>
      <table class="data-table">
        <thead><tr><th>Historical Shock Event</th><th>Pred BTC</th><th>Actual BTC</th><th>Crash Prob</th><th>Dir Hits</th><th>In P10..P90</th><th>MAE</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  private renderPortfolio(): void {
    const el = document.getElementById("portfolio-content");
    if (!el) return;
    const rep = this.portfolioEngine.evaluateImpact(
      this.portfolio,
      this.activeSim,
      this.dvolBtcPct,
    );

    const rows = rep.positions
      .map(
        (p) => `
      <tr>
        <td><b>${p.label}</b></td>
        <td>$${p.allocationUsd.toLocaleString()}</td>
        <td class="${p.expectedMovePct < 0 ? "neg" : "pos"}">${p.expectedMovePct > 0 ? "+" : ""}${p.expectedMovePct}%</td>
        <td class="${p.expectedPnlUsd < 0 ? "neg" : "pos"}"><b>${p.expectedPnlUsd >= 0 ? "+" : ""}$${p.expectedPnlUsd.toLocaleString()}</b></td>
        <td class="muted">$${p.p10PnlUsd.toLocaleString()} .. $${p.p90PnlUsd.toLocaleString()}</td>
      </tr>`,
      )
      .join("");

    el.innerHTML = `
      <div class="calib-cards" style="margin-bottom:14px;">
        <div class="c-card"><span>Total Portfolio</span><b>$${rep.totalUsd.toLocaleString()}</b></div>
        <div class="c-card"><span>Shock Expected P&amp;L</span><b class="${rep.expectedPnlUsd < 0 ? "neg" : "pos"}">${rep.expectedPnlUsd >= 0 ? "+" : ""}$${rep.expectedPnlUsd.toLocaleString()} (${rep.expectedPnlPct}%)</b></div>
        <div class="c-card"><span>1D VaR 95% (DVOL ${rep.dvolPctUsed}%)</span><b class="gold">-$${rep.var95DailyUsd.toLocaleString()}</b></div>
        <div class="c-card"><span>1D VaR 99% (Tail)</span><b class="neg">-$${rep.var99DailyUsd.toLocaleString()}</b></div>
      </div>
      <div class="insp-impact" style="margin-bottom:14px;"><b>Aladdin Hedge Desk:</b> ${rep.hedgeRecommendation}</div>
      <table class="data-table">
        <thead><tr><th>Asset</th><th>Allocation</th><th>Shock Move</th><th>Expected P&amp;L</th><th>P10..P90 P&amp;L Band</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  const app = new MalCryptoApp();
  void app.init();
});
