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
import type { StablecoinPegQuote } from "../feeds/live-feeds.js";

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
}

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
}

export class ExecutiveBriefingEngine {
  generate(input: BriefingInputs): ExecutiveBriefing {
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

    const compositeScore = Math.round(clamp(score, -100, 100));
    let verdict: ExecutiveBriefing["verdict"] = "WAIT";
    if (compositeScore >= 18) verdict = "LONG";
    else if (compositeScore <= -18) verdict = "SHORT";

    const confidencePct = Math.round(
      clamp(45 + Math.abs(compositeScore) * 0.5, 45, 92),
    );

    // Trade levels anchored to DVOL daily sigma
    const dailyVolPct = Math.max(1.5, input.dvolPct / Math.sqrt(365));
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
        input.dvolPct,
        compositeScore,
      ),
      this.computeHorizon(
        "Ближайшие 3 дня",
        72,
        price,
        input.dvolPct,
        compositeScore,
      ),
      this.computeHorizon(
        "Неделя (7 дней)",
        168,
        price,
        input.dvolPct,
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
    const sigmaT = (dvolPct / 100) * Math.sqrt(tYears); // e.g. 0.025 for 24h
    // Drift tilted by composite score
    const drift = (compositeScore / 100) * sigmaT * 0.65;

    const p50Price = Math.round(price * (1 + drift));
    const p10Price = Math.round(price * (1 + drift - 1.2816 * sigmaT));
    const p90Price = Math.round(price * (1 + drift + 1.2816 * sigmaT));

    // Probability of > +2.5% / < -2.5% move (scaled gently by horizon)
    const moveThresh = 0.02 * Math.sqrt(hours / 24);
    const zUp = (moveThresh - drift) / Math.max(0.005, sigmaT);
    const zDown = (-moveThresh - drift) / Math.max(0.005, sigmaT);

    const probUp = clamp(1 - normalCdf(zUp), 0.08, 0.78);
    const probDown = clamp(normalCdf(zDown), 0.08, 0.78);
    const probRange = clamp(1 - probUp - probDown, 0.1, 0.75);

    const sum = probUp + probDown + probRange;
    return {
      horizonLabel,
      hours,
      probUpPct: Math.round((probUp / sum) * 100),
      probRangePct: Math.round((probRange / sum) * 100),
      probDownPct: Math.round((probDown / sum) * 100),
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
