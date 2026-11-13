/**
 * MalCrypto Aladdin — Forecast Tracker & Historical Backtest Auditor (npm run audit)
 * Checks live verdicts & 24h horizon forecasts against real Binance OHLCV candles,
 * runs a 166-day (1000x 4h bars) walk-forward backtest + 4 historical shock replays,
 * and saves data/audit_report.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BacktestEngine } from "./aladdin/backtest.js";
import { BriefWalkForwardBacktester } from "./aladdin/brief-backtest.js";
import {
  BriefVerdictTracker,
  type BriefVerdictRecord,
} from "./aladdin/briefing.js";
import {
  HorizonForecastTracker,
  type HorizonForecastRecord,
} from "./aladdin/horizon-tracker.js";
import {
  fetchBinanceKlinesOhlcv,
  fetchDeribitDvol,
  fetchFearAndGreedHistory,
} from "./feeds/live-feeds.js";
import { TemporalKnowledgeGraph } from "./graph/temporal-graph.js";

const VERDICTS_PATH = resolve(process.cwd(), "data/verdicts.json");
const HORIZONS_PATH = resolve(process.cwd(), "data/horizon_forecasts.json");
const AUDIT_PATH = resolve(process.cwd(), "data/audit_report.json");

export async function runAudit(): Promise<void> {
  const [candles15m, candles4h, fgHistory, dvol] = await Promise.all([
    fetchBinanceKlinesOhlcv("BTCUSDT", "15m", 300),
    fetchBinanceKlinesOhlcv("BTCUSDT", "4h", 1000),
    fetchFearAndGreedHistory(180),
    fetchDeribitDvol("BTC"),
  ]);

  // 1. Resolve live LONG/SHORT verdicts by 15m candle wicks
  const verdictTracker = new BriefVerdictTracker();
  if (existsSync(VERDICTS_PATH)) {
    try {
      const saved = JSON.parse(
        readFileSync(VERDICTS_PATH, "utf8"),
      ) as BriefVerdictRecord[];
      if (Array.isArray(saved)) verdictTracker.loadRecords(saved);
    } catch {
      // ignore
    }
  }
  if (candles15m.length > 0) {
    verdictTracker.resolveDueVerdictsWithCandles(candles15m);
  }
  const verdictStats = verdictTracker.getStats();
  mkdirSync(dirname(VERDICTS_PATH), { recursive: true });
  writeFileSync(VERDICTS_PATH, JSON.stringify(verdictStats.records, null, 2));

  // 2. Resolve 24h Horizon Forecasts (P10..P90 & Brier Score)
  const horizonTracker = new HorizonForecastTracker();
  if (existsSync(HORIZONS_PATH)) {
    try {
      const savedHz = JSON.parse(
        readFileSync(HORIZONS_PATH, "utf8"),
      ) as HorizonForecastRecord[];
      if (Array.isArray(savedHz)) horizonTracker.loadRecords(savedHz);
    } catch {
      // ignore
    }
  }
  if (candles15m.length > 0) {
    horizonTracker.resolveWithCandles(candles15m);
  }
  const horizonStats = horizonTracker.getStats();
  writeFileSync(HORIZONS_PATH, JSON.stringify(horizonStats.records, null, 2));

  // 3. Real Walk-Forward Backtest (1000x 4h candles = ~166 days)
  const wfBacktester = new BriefWalkForwardBacktester();
  const walkForward = wfBacktester.run(
    candles4h,
    fgHistory,
    dvol?.dvolPct ?? 42,
  );

  // 4. Historical 4-Shock Contagion Replay
  const graph = new TemporalKnowledgeGraph(true);
  const shockBacktest = new BacktestEngine().runHistoricalSuite(graph);

  const verdictLabel =
    walkForward.totalTrades === 0
      ? "НЕТ_ДАННЫХ"
      : walkForward.expectancyPct > 0 && walkForward.profitFactor >= 1.15
        ? "ПОЛОЖИТЕЛЬНОЕ_МАТОЖИДАНИЕ"
        : walkForward.expectancyPct >= -0.2
          ? "ТРЕБУЕТ_КАЛИБРОВКИ"
          : "ОТРИЦАТЕЛЬНОЕ_МАТОЖИДАНИЕ";

  const report = {
    generatedAt: new Date().toISOString(),
    systemHealthStatus: verdictLabel,
    liveVerdicts: {
      total: verdictStats.total,
      resolved: verdictStats.resolved,
      wins: verdictStats.wins,
      winRatePct: Number((verdictStats.winRate * 100).toFixed(1)),
      avgReturnPct: verdictStats.avgReturnPct,
    },
    liveHorizons24h: {
      total: horizonStats.total,
      resolved: horizonStats.resolved,
      p10p90CoveragePct: horizonStats.p10p90CoveragePct,
      avgBrierScore: horizonStats.avgBrierScore,
      maePct: horizonStats.maePct,
    },
    walkForward166d: walkForward,
    historicalShocks4Cases: {
      overallBrierScore: shockBacktest.overallBrierScore,
      overallDirectionalAccuracyPct: Number(
        (shockBacktest.overallDirectionalAccuracy * 100).toFixed(1),
      ),
      overallIntervalCoveragePct: Number(
        (shockBacktest.overallIntervalCoverage * 100).toFixed(1),
      ),
      overallMaePct: shockBacktest.overallMaePct,
      cases: shockBacktest.cases,
    },
  };

  writeFileSync(AUDIT_PATH, JSON.stringify(report, null, 2));

  console.log("=== MALCRYPTO × ALADDIN: АУДИТ ПРОГНОЗОВ И БЭКТЕСТОВ ===");
  console.log(
    `[1] Живые сигналы (BRIEF): ${verdictStats.resolved}/${verdictStats.total} закрыто | ` +
      `Win Rate: ${(verdictStats.winRate * 100).toFixed(1)}% | Средн. доходность: ${verdictStats.avgReturnPct}%`,
  );
  console.log(
    `[2] Живые 24ч коридоры (P10..P90): ${horizonStats.resolved}/${horizonStats.total} закрыто | ` +
      `Попадание в P10..P90: ${horizonStats.p10p90CoveragePct}% | Brier: ${horizonStats.avgBrierScore} | MAE: ${horizonStats.maePct}%`,
  );
  console.log(
    `[3] Реальный Walk-Forward бэктест (${walkForward.startDateIso} .. ${walkForward.endDateIso}, ${walkForward.candlesTested} свечей 4ч): ` +
      `Сделок=${walkForward.totalTrades} (${walkForward.wins}W/${walkForward.losses}L) | ` +
      `Win Rate=${(walkForward.winRate * 100).toFixed(1)}% | Profit Factor=${walkForward.profitFactor} | ` +
      `Матожидание=${walkForward.expectancyPct}% | Макс.просадка=${walkForward.maxDrawdownPct}% | ` +
      `Оптим.порог=±${walkForward.recommendedThreshold} (${(walkForward.recommendedWinRate * 100).toFixed(1)}%)`,
  );
  console.log(
    `[4] Исторический бэктест 4 крахов (SVB, FTX, Yen Carry, NVDA): ` +
      `Brier=${shockBacktest.overallBrierScore} | Точность направления=${(shockBacktest.overallDirectionalAccuracy * 100).toFixed(1)}% | ` +
      `Попадание в P10..P90=${(shockBacktest.overallIntervalCoverage * 100).toFixed(1)}%`,
  );
  console.log(
    `[ИТОГ СИСТЕМЫ]: ${verdictLabel} -> отчёт сохранён в data/audit_report.json`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runAudit().catch((err) => {
    console.error("Audit error:", err);
    process.exit(1);
  });
}
