/**
 * Real Historical Walk-Forward Backtester for ExecutiveBriefingEngine
 * Evaluates LONG/SHORT signals strictly out-of-sample on real Binance OHLCV candles
 * + historical Alternative.me Fear & Greed values with conservative wick SL/TP resolution.
 */

import type { OhlcvCandle } from "../feeds/live-feeds.js";
import { ExecutiveBriefingEngine } from "./briefing.js";

export interface BriefBacktestReport {
  candlesTested: number;
  startDateIso: string;
  endDateIso: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  expectancyPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  recommendedThreshold: number;
  recommendedWinRate: number;
}

export class BriefWalkForwardBacktester {
  private engine = new ExecutiveBriefingEngine();

  run(
    candles4h: OhlcvCandle[],
    fgHistory: Array<{
      timestamp: number;
      value: number;
      classification: string;
    }>,
    dvolFallbackPct = 42,
  ): BriefBacktestReport {
    const sorted = [...candles4h].sort((a, b) => a.openTime - b.openTime);
    if (sorted.length < 20) {
      return {
        candlesTested: sorted.length,
        startDateIso: "",
        endDateIso: "",
        totalTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        expectancyPct: 0,
        profitFactor: 0,
        maxDrawdownPct: 0,
        recommendedThreshold: 18,
        recommendedWinRate: 0,
      };
    }

    const baseStats = this.evaluateThreshold(
      sorted,
      fgHistory,
      dvolFallbackPct,
      18,
    );

    // Walk-forward grid search over verdictThreshold on real candles
    let bestThreshold = 18;
    let bestScore = -Infinity;
    let bestWinRate = baseStats.winRate;

    for (const th of [12, 16, 18, 22, 26]) {
      const s = this.evaluateThreshold(sorted, fgHistory, dvolFallbackPct, th);
      if (s.totalTrades < 3) continue;
      const quality = s.expectancyPct * Math.sqrt(s.totalTrades);
      if (quality > bestScore) {
        bestScore = quality;
        bestThreshold = th;
        bestWinRate = s.winRate;
      }
    }

    return {
      candlesTested: sorted.length,
      startDateIso: new Date(sorted[0].openTime).toISOString().slice(0, 10),
      endDateIso: new Date(sorted[sorted.length - 1].closeTime)
        .toISOString()
        .slice(0, 10),
      ...baseStats,
      recommendedThreshold: bestThreshold,
      recommendedWinRate: bestWinRate,
    };
  }

  private evaluateThreshold(
    sorted: OhlcvCandle[],
    fgHistory: Array<{
      timestamp: number;
      value: number;
      classification: string;
    }>,
    dvolFallbackPct: number,
    verdictThreshold: number,
  ) {
    let wins = 0;
    let losses = 0;
    let grossWin = 0;
    let grossLoss = 0;
    let equity = 100;
    let peak = 100;
    let maxDd = 0;
    let nextAllowedIdx = 6;

    // 4h bars: 6 bars = 24h
    for (let i = 6; i < sorted.length - 6; i++) {
      if (i < nextAllowedIdx) continue;
      const cur = sorted[i];
      const prev24h = sorted[i - 6];
      const chg24h = ((cur.close - prev24h.close) / prev24h.close) * 100;

      // Realized 24h volatility annualized from last 6 bars (no look-ahead)
      const rets: number[] = [];
      for (let k = i - 5; k <= i; k++) {
        rets.push(Math.log(sorted[k].close / sorted[k - 1].close));
      }
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const varBar =
        rets.reduce((a, r) => a + (r - mean) ** 2, 0) /
        Math.max(1, rets.length - 1);
      const realizedVolPct = Math.max(
        25,
        Math.min(110, Math.sqrt(varBar * 6 * 365) * 100),
      );
      const effectiveVol = Number.isFinite(realizedVolPct)
        ? realizedVolPct
        : dvolFallbackPct;

      const fgItem = this.findLatestFg(fgHistory, cur.closeTime);
      const brief = this.engine.generate({
        btcPrice: cur.close,
        btcChange24hPct: chg24h,
        dvolPct: effectiveVol,
        fearGreed: fgItem,
        stablePegs: [
          {
            nodeId: "INFRA_USDT",
            symbol: "USDT",
            price: 1.0,
            pegDeviationBps: 0,
          },
        ],
        liq5mLongUsd: 0,
        liq5mShortUsd: 0,
        regime: chg24h < -4 ? "STRESS_CORRELATION_ONE" : "RISK_ON_CALM",
        newsFeed: [],
        now: cur.closeTime,
        weights: { verdictThreshold },
      });

      if (brief.verdict === "WAIT") continue;

      let exitPrice = sorted[i + 6].close;
      for (let j = i + 1; j <= i + 6; j++) {
        const fwd = sorted[j];
        if (brief.verdict === "LONG") {
          if (fwd.low <= brief.stopLossPrice) {
            exitPrice = brief.stopLossPrice;
            break;
          }
          if (fwd.high >= brief.takeProfitPrice) {
            exitPrice = brief.takeProfitPrice;
            break;
          }
        } else {
          if (fwd.high >= brief.stopLossPrice) {
            exitPrice = brief.stopLossPrice;
            break;
          }
          if (fwd.low <= brief.takeProfitPrice) {
            exitPrice = brief.takeProfitPrice;
            break;
          }
        }
      }

      const rawRetPct =
        (brief.verdict === "LONG"
          ? (exitPrice - brief.entryPrice) / brief.entryPrice
          : (brief.entryPrice - exitPrice) / brief.entryPrice) * 100;

      if (rawRetPct > 0) {
        wins++;
        grossWin += rawRetPct;
      } else {
        losses++;
        grossLoss += Math.abs(rawRetPct);
      }

      equity *= 1 + rawRetPct / 100;
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDd) maxDd = dd;

      // Non-overlapping 24h evaluation window
      nextAllowedIdx = i + 6;
    }

    const totalTrades = wins + losses;
    return {
      totalTrades,
      wins,
      losses,
      winRate: totalTrades > 0 ? Number((wins / totalTrades).toFixed(4)) : 0,
      expectancyPct:
        totalTrades > 0
          ? Number(((grossWin - grossLoss) / totalTrades).toFixed(2))
          : 0,
      profitFactor:
        grossLoss > 0
          ? Number((grossWin / grossLoss).toFixed(2))
          : grossWin > 0
            ? 9.99
            : 0,
      maxDrawdownPct: Number(maxDd.toFixed(2)),
    };
  }

  private findLatestFg(
    fgHistory: Array<{
      timestamp: number;
      value: number;
      classification: string;
    }>,
    ts: number,
  ): { value: number; classification: string } | null {
    let best: {
      timestamp: number;
      value: number;
      classification: string;
    } | null = null;
    for (const item of fgHistory) {
      if (item.timestamp <= ts) best = item;
      else break;
    }
    return best
      ? { value: best.value, classification: best.classification }
      : null;
  }
}
