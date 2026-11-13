import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BriefWalkForwardBacktester } from "../src/aladdin/brief-backtest.js";
import {
  BriefVerdictTracker,
  type ExecutiveBriefing,
} from "../src/aladdin/briefing.js";
import { HorizonForecastTracker } from "../src/aladdin/horizon-tracker.js";
import { EventDatabaseStore } from "../src/feeds/events-db.js";
import type { OhlcvCandle } from "../src/feeds/live-feeds.js";

describe("Phase 6: Honest Candle-Wick Resolver, Walk-Forward Backtest & Events DB", () => {
  it("resolves open verdicts using historical candle wicks and prioritizes SL on same-bar ambiguity", () => {
    const tracker = new BriefVerdictTracker();
    const t0 = Date.UTC(2026, 10, 10, 0, 0);

    const brief: ExecutiveBriefing = {
      verdict: "LONG",
      confidencePct: 75,
      compositeScore: 32,
      btcPrice: 70_000,
      entryPrice: 70_000,
      stopLossPrice: 68_500,
      takeProfitPrice: 73_300,
      riskRewardRatio: 2.2,
      headlineSummary: "test",
      drivers: [],
      horizons: [],
      topNewsCatalysts: [],
      upcomingMacroEvents: [],
    };
    tracker.recordVerdict(brief, t0);

    // Candle 1 hits BOTH SL (68_400) and TP (73_500) -> conservatively resolves as SL_HIT
    const candles: OhlcvCandle[] = [
      {
        openTime: t0 + 1000,
        closeTime: t0 + 900_000,
        open: 70_000,
        high: 73_500,
        low: 68_400,
        close: 72_000,
        volume: 100,
      },
    ];
    const changed = tracker.resolveDueVerdictsWithCandles(
      candles,
      t0 + 1000_000,
    );
    assert.equal(changed, true);
    const stats = tracker.getStats();
    assert.equal(stats.resolved, 1);
    assert.equal(stats.records[0].resolveReason, "SL_HIT");
    assert.equal(stats.records[0].outcome, "LOSS");
  });

  it("runs walk-forward backtest over 4h OHLCV candles and F&G history", () => {
    const backtester = new BriefWalkForwardBacktester();
    const t0 = Date.UTC(2026, 8, 1, 0, 0);
    const candles: OhlcvCandle[] = [];
    let price = 60_000;
    for (let i = 0; i < 60; i++) {
      const openTime = t0 + i * 4 * 3600 * 1000;
      const delta = i % 10 < 5 ? 400 : -350;
      const next = price + delta;
      candles.push({
        openTime,
        closeTime: openTime + 4 * 3600 * 1000 - 1,
        open: price,
        high: Math.max(price, next) + 250,
        low: Math.min(price, next) - 250,
        close: next,
        volume: 500,
      });
      price = next;
    }
    const fgHistory = [
      { timestamp: t0, value: 20, classification: "Extreme Fear" },
      {
        timestamp: t0 + 30 * 4 * 3600 * 1000,
        value: 82,
        classification: "Extreme Greed",
      },
    ];

    const rep = backtester.run(candles, fgHistory, 40);
    assert.equal(rep.candlesTested, 60);
    assert.ok(rep.totalTrades >= 0);
    assert.ok(rep.recommendedThreshold >= 12);
  });

  it("deduplicates and queries global events database by category and keyword", () => {
    const db = new EventDatabaseStore();
    const added = db.upsertMany([
      {
        id: "ev1",
        timestamp: 2000,
        title: "Federal Reserve holds rates steady",
        source: "Fed",
        category: "MACRO",
        matchedNodes: ["ACTOR_POWELL"],
        surpriseScore: 0.2,
        impact: "CRITICAL",
      },
      {
        id: "ev2",
        timestamp: 1000,
        title: "Federal Reserve holds rates steady",
        source: "Mirror",
        category: "MACRO",
        matchedNodes: ["ACTOR_POWELL"],
        surpriseScore: 0.2,
        impact: "CRITICAL",
      },
      {
        id: "ev3",
        timestamp: 3000,
        title: "NVIDIA insider Form 4 filing",
        source: "SEC EDGAR",
        category: "INSIDER",
        matchedNodes: ["EQ_NVDA"],
        surpriseScore: -0.3,
        impact: "HIGH",
      },
    ]);
    assert.equal(added, 2);
    assert.equal(db.query({ category: "INSIDER" }).length, 1);
    assert.equal(db.query({ search: "nvidia" }).length, 1);
  });

  it("tracks 24h horizon P10..P90 forecasts and computes Brier score after 24h", () => {
    const tracker = new HorizonForecastTracker();
    const t0 = Date.UTC(2026, 10, 10, 0, 0);
    const brief: ExecutiveBriefing = {
      verdict: "WAIT",
      confidencePct: 50,
      compositeScore: 8,
      btcPrice: 70_000,
      entryPrice: 70_000,
      stopLossPrice: 68_500,
      takeProfitPrice: 73_300,
      riskRewardRatio: 2.2,
      headlineSummary: "test",
      drivers: [],
      horizons: [
        {
          horizonLabel: "Сегодня (24ч)",
          hours: 24,
          probUpPct: 20,
          probRangePct: 65,
          probDownPct: 15,
          p10Price: 68_000,
          p50Price: 70_200,
          p90Price: 72_200,
          expectedMovePct: 0.28,
        },
      ],
      topNewsCatalysts: [],
      upcomingMacroEvents: [],
    };
    const rec = tracker.recordFromBriefing(brief, t0);
    assert.ok(rec);
    const after24h = t0 + 24 * 3600 * 1000 + 60_000;
    const changed = tracker.resolveWithCandles(
      [
        {
          openTime: t0 + 24 * 3600 * 1000,
          closeTime: after24h,
          open: 70_100,
          high: 70_600,
          low: 69_900,
          close: 70_500,
          volume: 100,
        },
      ],
      after24h,
    );
    assert.equal(changed, true);
    const stats = tracker.getStats();
    assert.equal(stats.resolved, 1);
    assert.equal(stats.p10p90CoveragePct, 100);
    assert.equal(stats.avgBrierScore, 0.04);
  });
});
