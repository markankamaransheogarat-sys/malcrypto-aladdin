/**
 * 24h Horizon Probability & P10..P90 Cone Tracker
 * Tracks every 24h forecast (even when verdict is WAIT) and resolves it after 24h
 * against real Binance OHLCV candles to measure Brier Score & P10..P90 coverage.
 */

import { brierScore } from "../core/math.js";
import type { OhlcvCandle } from "../feeds/live-feeds.js";
import type { ExecutiveBriefing } from "./briefing.js";

export interface HorizonForecastRecord {
  id: string;
  timestamp: number;
  startPrice: number;
  p10Price: number;
  p50Price: number;
  p90Price: number;
  probUpPct: number;
  probDownPct: number;
  resolvedAt?: number;
  actualPrice24h?: number;
  actualMovePct?: number;
  inP10P90?: boolean;
  brierDirection?: number;
}

export interface HorizonTrackerStats {
  total: number;
  resolved: number;
  p10p90CoveragePct: number;
  avgBrierScore: number;
  maePct: number;
  records: HorizonForecastRecord[];
}

export class HorizonForecastTracker {
  private records: HorizonForecastRecord[] = [];
  private readonly throttleMs = 4 * 3600 * 1000;
  private readonly horizonMs = 24 * 3600 * 1000;

  loadRecords(saved: HorizonForecastRecord[]): void {
    const seen = new Set(this.records.map((r) => r.id));
    for (const r of saved) {
      if (r && r.id && !seen.has(r.id)) {
        this.records.push(r);
        seen.add(r.id);
      }
    }
    if (this.records.length > 300) {
      this.records = this.records.slice(-300);
    }
  }

  recordFromBriefing(
    briefing: ExecutiveBriefing,
    now = Date.now(),
  ): HorizonForecastRecord | null {
    const h24 = briefing.horizons.find((h) => h.hours === 24);
    if (!h24 || briefing.btcPrice <= 0) return null;

    const latest = this.records[this.records.length - 1];
    if (latest && now - latest.timestamp < this.throttleMs) return null;

    const rec: HorizonForecastRecord = {
      id: `hz24_${now}`,
      timestamp: now,
      startPrice: briefing.btcPrice,
      p10Price: h24.p10Price,
      p50Price: h24.p50Price,
      p90Price: h24.p90Price,
      probUpPct: h24.probUpPct,
      probDownPct: h24.probDownPct,
    };
    this.records.push(rec);
    if (this.records.length > 300) {
      this.records = this.records.slice(-300);
    }
    return rec;
  }

  resolveWithCandles(candles: OhlcvCandle[], now = Date.now()): boolean {
    if (candles.length === 0) return false;
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    let changed = false;

    for (const r of this.records) {
      if (r.resolvedAt) continue;
      const targetTs = r.timestamp + this.horizonMs;
      if (now < targetTs) continue;

      // Find first candle closing at or after targetTs, or fallback to latest candle
      const match =
        sorted.find((c) => c.closeTime >= targetTs) ??
        sorted[sorted.length - 1];
      if (!match) continue;

      const actual = match.close;
      const movePct = ((actual - r.startPrice) / r.startPrice) * 100;
      const inCone = actual >= r.p10Price && actual <= r.p90Price;

      // Brier score on >+2.5% breakout event probability
      const upBreakoutOccurred = movePct >= 2.5 ? 1 : 0;
      const brier = brierScore([
        { prob: r.probUpPct / 100, outcome: upBreakoutOccurred },
      ]);

      r.resolvedAt = match.closeTime;
      r.actualPrice24h = Math.round(actual);
      r.actualMovePct = Number(movePct.toFixed(2));
      r.inP10P90 = inCone;
      r.brierDirection = Number(brier.toFixed(4));
      changed = true;
    }
    return changed;
  }

  getStats(): HorizonTrackerStats {
    const res = this.records.filter((r) => r.resolvedAt !== undefined);
    const inConeCount = res.filter((r) => r.inP10P90).length;
    const avgBrier =
      res.length > 0
        ? res.reduce((acc, r) => acc + (r.brierDirection ?? 0), 0) / res.length
        : 0;
    const maePct =
      res.length > 0
        ? res.reduce(
            (acc, r) =>
              acc +
              Math.abs(
                ((r.actualPrice24h ?? r.startPrice) - r.p50Price) /
                  r.startPrice,
              ) *
                100,
            0,
          ) / res.length
        : 0;

    return {
      total: this.records.length,
      resolved: res.length,
      p10p90CoveragePct:
        res.length > 0
          ? Number(((inConeCount / res.length) * 100).toFixed(1))
          : 0,
      avgBrierScore: Number(avgBrier.toFixed(4)),
      maePct: Number(maePct.toFixed(2)),
      records: [...this.records],
    };
  }
}
