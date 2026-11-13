/**
 * Executive BTC & Market Command Briefing Engine (BRIEF <GO>)
 * Synthesizes live orderflow, fragility, DVOL, macro, and news into:
 * 1. Actionable Verdict (LONG / SHORT / WAIT) with Entry, Stop, Target
 * 2. Plain-language explanation of WHY BTC is moving right now
 * 3. Multi-Horizon Probability Forecasts (24h / 3 Days / 7 Days)
 */

import { clamp } from "../core/math.js";
import type {
  FragilityMetrics,
  MarketRegime,
  NewsEvent,
} from "../core/types.js";
import type { OhlcvCandle, StablecoinPegQuote } from "../feeds/live-feeds.js";
import {
  MacroCalendarEngine,
  type MacroCalendarEvent,
} from "./macro-calendar.js";

export interface HorizonForecast {
  horizonLabel: string;
  hours: number;
  probUpPct: number;
  probRangePct: number;
  probDownPct: number;
  p10Price: number;
  p50Price: number;
  p90Price: number;
  expectedMovePct: number;
}

export interface BriefingDriver {
  factor: string;
  impact: "BULLISH" | "BEARISH" | "NEUTRAL";
  weight: number;
  explanation: string;
}

export interface ExecutiveBriefing {
  verdict: "LONG" | "SHORT" | "WAIT";
  confidencePct: number;
  compositeScore: number; // -100..+100
  btcPrice: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  riskRewardRatio: number;
  headlineSummary: string;
  drivers: BriefingDriver[];
  horizons: HorizonForecast[];
  topNewsCatalysts: NewsEvent[];
  upcomingMacroEvents: MacroCalendarEvent[];
}

export interface BriefingWeights {
  newsScale: number;
  derivScale: number;
  fgScale: number;
  pegScale: number;
  momentumScale: number;
  verdictThreshold: number;
}

export const DEFAULT_BRIEFING_WEIGHTS: BriefingWeights = {
  newsScale: 1,
  derivScale: 1,
  fgScale: 1,
  pegScale: 1,
  momentumScale: 1,
  verdictThreshold: 18,
};

export interface BriefingInputs {
  btcPrice: number;
  btcChange24hPct: number;
  dvolPct: number;
  btcFragility?: FragilityMetrics;
  fearGreed?: { value: number; classification: string } | null;
  stablePegs: StablecoinPegQuote[];
  liq5mLongUsd: number;
  liq5mShortUsd: number;
  regime: MarketRegime;
  newsFeed: NewsEvent[];
  jpyPerUsd?: number;
  deribitPutCallRatio?: number;
  mempoolFeeSatVb?: number;
  weights?: Partial<BriefingWeights>;
  now?: number;
}

export class ExecutiveBriefingEngine {
  private macroCalendar = new MacroCalendarEngine();

  generate(input: BriefingInputs): ExecutiveBriefing {
    const now = input.now ?? Date.now();
    const upcomingMacroEvents = this.macroCalendar.getUpcomingEvents(now, 14);
    const { boostPct, imminentEvent } =
      this.macroCalendar.getImminentDvolBoostPct(now);
    const effectiveDvol = input.dvolPct * (1 + boostPct / 100);
    const price = input.btcPrice > 0 ? input.btcPrice : 71_000;
    const drivers: BriefingDriver[] = [];
    let score = 0;

    // 1. News Surprise Catalyst (-30..+30)
    const btcNews = input.newsFeed
      .filter((n) => n.matchedNodes.length > 0)
      .slice(0, 6);
    const avgSurprise =
      btcNews.length > 0
        ? btcNews.reduce((acc, n) => acc + n.surpriseScore * n.trustScore, 0) /
          btcNews.length
        : 0;
    const newsPoints = clamp(avgSurprise * 30, -30, 30);
    score += newsPoints;
    drivers.push({
      factor: "News & Event Surprise",
      impact:
        newsPoints > 4 ? "BULLISH" : newsPoints < -4 ? "BEARISH" : "NEUTRAL",
      weight: Math.round(newsPoints),
      explanation:
        btcNews.length > 0
          ? `${btcNews.length} активных новостей по узлам графа (средний Surprise: ${avgSurprise.toFixed(2)}). Главная: "${btcNews[0].title.slice(0, 75)}"`
          : "Сильных неожиданных новостей за последний час не зафиксировано.",
    });

    // 2. Derivatives Fragility & Funding Crowding (-25..+25)
    const frag = input.btcFragility;
    if (frag) {
      const fundingBps = frag.fundingRate8h * 10_000;
      let derivPoints = 0;
      let expl = `Fragility ${frag.fragilityScore}/100 (${frag.status}), Funding ${(frag.fundingRate8h * 100).toFixed(4)}%, OI/Depth ${frag.oiToDepthRatio}x.`;
      if (frag.status === "TINDERBOX" && fundingBps > 2.5) {
        derivPoints = -20;
        expl += " Перегруженные лонги — высокий риск каскадного сквиза вниз.";
      } else if (fundingBps < -1.0) {
        derivPoints = 18;
        expl += " Отрицательный фандинг — топливо для шорт-сквиза вверх.";
      } else if (frag.status === "RESILIENT") {
        derivPoints = 8;
        expl += " Стакан плотный, плечо не перегрето.";
      }
      score += derivPoints;
      drivers.push({
        factor: "Perp Leverage & Orderbook",
        impact:
          derivPoints > 3
            ? "BULLISH"
            : derivPoints < -3
              ? "BEARISH"
              : "NEUTRAL",
        weight: Math.round(derivPoints),
        explanation: expl,
      });
    }

    // 3. Fear & Greed Contrarian / Momentum (-15..+15)
    if (input.fearGreed) {
      const fg = input.fearGreed.value;
      let fgPts = 0;
      let expl = `Индекс страха и жадности: ${fg}/100 (${input.fearGreed.classification}).`;
      if (fg <= 25) {
        fgPts = 14;
        expl += " Экстремальный страх исторически близок к зонам откупа.";
      } else if (fg >= 78) {
        fgPts = -14;
        expl += " Экстремальная жадность — высокий риск коррекции.";
      }
      score += fgPts;
      drivers.push({
        factor: "Crowd Sentiment (F&G)",
        impact: fgPts > 0 ? "BULLISH" : fgPts < 0 ? "BEARISH" : "NEUTRAL",
        weight: fgPts,
        explanation: expl,
      });
    }

    // 4. Stablecoin Peg Health (-20..+5)
    const worstPeg = [...input.stablePegs].sort(
      (a, b) => Math.abs(b.pegDeviationBps) - Math.abs(a.pegDeviationBps),
    )[0];
    if (worstPeg) {
      const dev = Math.abs(worstPeg.pegDeviationBps);
      const pegPts = dev >= 30 ? -22 : dev >= 15 ? -8 : 5;
      score += pegPts;
      drivers.push({
        factor: "Stablecoin Liquidity Peg",
        impact: pegPts < 0 ? "BEARISH" : "BULLISH",
        weight: pegPts,
        explanation: `${worstPeg.symbol} торгуется по $${worstPeg.price.toFixed(4)} (отклонение ${worstPeg.pegDeviationBps} bps).`,
      });
    }

    // 5. 24h Momentum & Liquidations (-15..+15)
    const chg = input.btcChange24hPct;
    const liqDelta = input.liq5mShortUsd - input.liq5mLongUsd;
    const momPts = clamp(
      chg * 1.5 + (liqDelta > 100_000 ? 6 : liqDelta < -100_000 ? -6 : 0),
      -15,
      15,
    );
    score += momPts;
    drivers.push({
      factor: "Spot Momentum & Liquidations",
      impact: momPts > 3 ? "BULLISH" : momPts < -3 ? "BEARISH" : "NEUTRAL",
      weight: Math.round(momPts),
      explanation: `BTC 24h: ${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%. Ликвидации (5м): Long $${(input.liq5mLongUsd / 1e3).toFixed(0)}K vs Short $${(input.liq5mShortUsd / 1e3).toFixed(0)}K.`,
    });

    // 6. Deribit Options Put/Call OI & Mempool On-Chain Congestion
    if (
      typeof input.deribitPutCallRatio === "number" &&
      input.deribitPutCallRatio > 0
    ) {
      const pcr = input.deribitPutCallRatio;
      const pcrPts = pcr >= 1.1 ? -8 : pcr <= 0.65 ? 6 : 0;
      score += pcrPts;
      drivers.push({
        factor: "Deribit Options Put/Call",
        impact: pcrPts > 0 ? "BULLISH" : pcrPts < 0 ? "BEARISH" : "NEUTRAL",
        weight: pcrPts,
        explanation: `Deribit BTC Put/Call OI: ${pcr.toFixed(2)}${pcr >= 1.1 ? " (хедж путами повышен)" : pcr <= 0.65 ? " (преобладает спрос на коллы)" : " (нейтральный баланс)"}.`,
      });
    }

    if (
      typeof input.mempoolFeeSatVb === "number" &&
      input.mempoolFeeSatVb > 0
    ) {
      drivers.push({
        factor: "Bitcoin Mempool On-Chain",
        impact: "NEUTRAL",
        weight: 0,
        explanation: `Комиссия сети BTC: ${input.mempoolFeeSatVb} sat/vB${input.mempoolFeeSatVb >= 60 ? " (высокая перегрузка мемпула)" : " (сеть спокойная)"}.`,
      });
    }

    // 7. Imminent Macro / Options Expiry Calendar (<=48h)
    if (imminentEvent) {
      drivers.push({
        factor: "Macro Event Calendar",
        impact: "NEUTRAL",
        weight: 0,
        explanation: `${imminentEvent.title} через ${imminentEvent.hoursUntil}ч (${imminentEvent.impact}). Ожидается всплеск волатильности (DVOL +${boostPct}%).`,
      });
    }

    const thresh =
      input.weights?.verdictThreshold ??
      DEFAULT_BRIEFING_WEIGHTS.verdictThreshold;
    const compositeScore = Math.round(clamp(score, -100, 100));
    let verdict: ExecutiveBriefing["verdict"] = "WAIT";
    if (compositeScore >= thresh) verdict = "LONG";
    else if (compositeScore <= -thresh) verdict = "SHORT";

    const confidencePct = Math.round(
      clamp(45 + Math.abs(compositeScore) * 0.5, 45, 92),
    );

    // Trade levels anchored to effective DVOL daily sigma
    const dailyVolPct = Math.max(1.5, effectiveDvol / Math.sqrt(365));
    const stopPct = dailyVolPct * 1.15;
    const tpPct = stopPct * 2.2;

    const entryPrice = Math.round(price);
    const stopLossPrice =
      verdict === "SHORT"
        ? Math.round(price * (1 + stopPct / 100))
        : Math.round(price * (1 - stopPct / 100));
    const takeProfitPrice =
      verdict === "SHORT"
        ? Math.round(price * (1 - tpPct / 100))
        : Math.round(price * (1 + tpPct / 100));

    // Multi-Horizon Forecasts (24h, 3d, 7d)
    const horizons = [
      this.computeHorizon(
        "Сегодня (24ч)",
        24,
        price,
        effectiveDvol,
        compositeScore,
      ),
      this.computeHorizon(
        "Ближайшие 3 дня",
        72,
        price,
        effectiveDvol,
        compositeScore,
      ),
      this.computeHorizon(
        "Неделя (7 дней)",
        168,
        price,
        effectiveDvol,
        compositeScore,
      ),
    ];

    const topDriver = [...drivers].sort(
      (a, b) => Math.abs(b.weight) - Math.abs(a.weight),
    )[0];
    const headlineSummary =
      verdict === "WAIT"
        ? `Рынок в балансе (Score ${compositeScore}). Главный фактор: ${topDriver.factor}. Лучше ждать пробоя или нового катализатора.`
        : `Сигнал ${verdict} (уверенность ${confidencePct}%). Драйвер: ${topDriver.explanation}`;

    return {
      verdict,
      confidencePct,
      compositeScore,
      btcPrice: Math.round(price),
      entryPrice,
      stopLossPrice,
      takeProfitPrice,
      riskRewardRatio: 2.2,
      headlineSummary,
      drivers: drivers.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight)),
      horizons,
      topNewsCatalysts: btcNews.slice(0, 3),
      upcomingMacroEvents,
    };
  }

  private computeHorizon(
    horizonLabel: string,
    hours: number,
    price: number,
    dvolPct: number,
    compositeScore: number,
  ): HorizonForecast {
    const tYears = hours / (365 * 24);
    const sigmaT = (dvolPct / 100) * Math.sqrt(tYears); // e.g. ~2.1% for 24h, ~3.6% for 3d, ~5.5% for 7d
    // Drift tilted by composite score
    const drift = (compositeScore / 100) * sigmaT * 0.65;

    const p50Price = Math.round(price * (1 + drift));
    const p10Price = Math.round(price * (1 + drift - 1.2816 * sigmaT));
    const p90Price = Math.round(price * (1 + drift + 1.2816 * sigmaT));

    // Fixed ±2.5% directional breakout threshold so probabilities expand realistically with horizon
    const moveThresh = 0.025;
    const zUp = (moveThresh - drift) / Math.max(0.005, sigmaT);
    const zDown = (-moveThresh - drift) / Math.max(0.005, sigmaT);

    const probUp = clamp(1 - normalCdf(zUp), 0.05, 0.85);
    const probDown = clamp(normalCdf(zDown), 0.05, 0.85);
    const probRange = clamp(1 - probUp - probDown, 0.08, 0.85);

    const sum = probUp + probDown + probRange;
    const probUpPct = Math.round((probUp / sum) * 100);
    const probDownPct = Math.round((probDown / sum) * 100);
    const probRangePct = 100 - probUpPct - probDownPct;
    return {
      horizonLabel,
      hours,
      probUpPct,
      probRangePct,
      probDownPct,
      p10Price,
      p50Price,
      p90Price,
      expectedMovePct: Number((drift * 100).toFixed(2)),
    };
  }
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d *
    t *
    (0.3193815 +
      t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

export interface BriefVerdictRecord {
  id: string;
  timestamp: number;
  verdict: "LONG" | "SHORT";
  confidencePct: number;
  entryPrice: number;
  stopLossPrice: number;
  takeProfitPrice: number;
  resolvedAt?: number;
  exitPrice?: number;
  outcome?: "WIN" | "LOSS";
  returnPct?: number;
  resolveReason?: "TP_HIT" | "SL_HIT" | "EXPIRED_24H";
}

export interface BriefVerdictStats {
  total: number;
  resolved: number;
  wins: number;
  winRate: number;
  avgReturnPct: number;
  records: BriefVerdictRecord[];
}

export class BriefVerdictTracker {
  private records: BriefVerdictRecord[] = [];
  private readonly throttleMs = 4 * 3600 * 1000;
  private readonly horizonMs = 24 * 3600 * 1000;

  loadRecords(saved: BriefVerdictRecord[]): void {
    const seen = new Set(this.records.map((r) => r.id));
    for (const r of saved) {
      if (!seen.has(r.id)) {
        this.records.push(r);
        seen.add(r.id);
      }
    }
    if (this.records.length > 200) {
      this.records = this.records.slice(-200);
    }
  }

  recordVerdict(
    briefing: ExecutiveBriefing,
    now = Date.now(),
  ): BriefVerdictRecord | null {
    if (briefing.verdict === "WAIT" || briefing.entryPrice <= 0) return null;

    const recentSame = this.records.find(
      (r) =>
        r.verdict === briefing.verdict && now - r.timestamp < this.throttleMs,
    );
    if (recentSame) return null;

    const rec: BriefVerdictRecord = {
      id: `brief_${now}_${briefing.verdict}`,
      timestamp: now,
      verdict: briefing.verdict,
      confidencePct: briefing.confidencePct,
      entryPrice: briefing.entryPrice,
      stopLossPrice: briefing.stopLossPrice,
      takeProfitPrice: briefing.takeProfitPrice,
    };
    this.records.push(rec);
    if (this.records.length > 200) {
      this.records = this.records.slice(-200);
    }
    return rec;
  }

  resolveDueVerdicts(currentBtcPrice: number, now = Date.now()): boolean {
    if (currentBtcPrice <= 0) return false;
    let changed = false;

    for (const r of this.records) {
      if (r.resolvedAt) continue;

      let reason: BriefVerdictRecord["resolveReason"] | undefined;
      if (r.verdict === "LONG") {
        if (currentBtcPrice >= r.takeProfitPrice) reason = "TP_HIT";
        else if (currentBtcPrice <= r.stopLossPrice) reason = "SL_HIT";
      } else {
        if (currentBtcPrice <= r.takeProfitPrice) reason = "TP_HIT";
        else if (currentBtcPrice >= r.stopLossPrice) reason = "SL_HIT";
      }

      if (!reason && now - r.timestamp >= this.horizonMs) {
        reason = "EXPIRED_24H";
      }

      if (reason) {
        const rawReturn =
          r.verdict === "LONG"
            ? (currentBtcPrice - r.entryPrice) / r.entryPrice
            : (r.entryPrice - currentBtcPrice) / r.entryPrice;
        r.resolvedAt = now;
        r.exitPrice = Math.round(currentBtcPrice);
        r.returnPct = Number((rawReturn * 100).toFixed(2));
        r.outcome = rawReturn > 0 ? "WIN" : "LOSS";
        r.resolveReason = reason;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Honest historical candle-wick resolver: checks every real OHLCV candle
   * since the verdict timestamp so SL/TP hits between browser visits are never missed.
   * Conservatively checks SL before TP if both are touched within the same bar.
   */
  resolveDueVerdictsWithCandles(
    candles: OhlcvCandle[],
    now = Date.now(),
  ): boolean {
    if (candles.length === 0) return false;
    const sorted = [...candles].sort((a, b) => a.openTime - b.openTime);
    let changed = false;

    for (const r of this.records) {
      if (r.resolvedAt) continue;

      const relevant = sorted.filter((c) => c.closeTime > r.timestamp);
      let exitPrice: number | undefined;
      let resolvedAt: number | undefined;
      let reason: BriefVerdictRecord["resolveReason"] | undefined;

      for (const c of relevant) {
        if (r.verdict === "LONG") {
          if (c.low <= r.stopLossPrice) {
            reason = "SL_HIT";
            exitPrice = r.stopLossPrice;
            resolvedAt = c.closeTime;
            break;
          }
          if (c.high >= r.takeProfitPrice) {
            reason = "TP_HIT";
            exitPrice = r.takeProfitPrice;
            resolvedAt = c.closeTime;
            break;
          }
        } else {
          if (c.high >= r.stopLossPrice) {
            reason = "SL_HIT";
            exitPrice = r.stopLossPrice;
            resolvedAt = c.closeTime;
            break;
          }
          if (c.low <= r.takeProfitPrice) {
            reason = "TP_HIT";
            exitPrice = r.takeProfitPrice;
            resolvedAt = c.closeTime;
            break;
          }
        }

        if (c.closeTime - r.timestamp >= this.horizonMs) {
          reason = "EXPIRED_24H";
          exitPrice = c.close;
          resolvedAt = c.closeTime;
          break;
        }
      }

      if (!reason && now - r.timestamp >= this.horizonMs) {
        const last = sorted[sorted.length - 1];
        reason = "EXPIRED_24H";
        exitPrice = last.close;
        resolvedAt = now;
      }

      if (reason && exitPrice !== undefined && resolvedAt !== undefined) {
        const rawReturn =
          r.verdict === "LONG"
            ? (exitPrice - r.entryPrice) / r.entryPrice
            : (r.entryPrice - exitPrice) / r.entryPrice;
        r.resolvedAt = resolvedAt;
        r.exitPrice = Math.round(exitPrice);
        r.returnPct = Number((rawReturn * 100).toFixed(2));
        r.outcome = rawReturn > 0 ? "WIN" : "LOSS";
        r.resolveReason = reason;
        changed = true;
      }
    }
    return changed;
  }

  getStats(): BriefVerdictStats {
    const resolvedList = this.records.filter((r) => r.resolvedAt !== undefined);
    const wins = resolvedList.filter((r) => r.outcome === "WIN").length;
    const sumReturn = resolvedList.reduce(
      (acc, r) => acc + (r.returnPct ?? 0),
      0,
    );
    return {
      total: this.records.length,
      resolved: resolvedList.length,
      wins,
      winRate: resolvedList.length > 0 ? wins / resolvedList.length : 0,
      avgReturnPct:
        resolvedList.length > 0
          ? Number((sumReturn / resolvedList.length).toFixed(2))
          : 0,
      records: [...this.records],
    };
  }
}
