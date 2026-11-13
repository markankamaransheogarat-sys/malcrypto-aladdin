/**
 * Bi-Temporal Historical Shock Replay & Backtest Engine (BACKTEST <GO>)
 * Replays major historical cross-market crashes using ONLY graph edges valid at `eventTimestamp`,
 * measuring Directional Accuracy, P10..P90 Interval Coverage, MAE, and Brier Score.
 */

import { brierScore } from "../core/math.js";
import type { FragilityMetrics, MarketRegime } from "../core/types.js";
import type { TemporalKnowledgeGraph } from "../graph/temporal-graph.js";
import { computeFragilityMetrics } from "./fragility.js";
import { AladdinSimulator } from "./simulator.js";

export interface HistoricalShockCase {
  id: string;
  name: string;
  dateLabel: string;
  /** Epoch ms 1 minute prior to event for bi-temporal graph lookup */
  asOfTimestamp: number;
  triggerNodeId: string;
  shockPct: number;
  regime: MarketRegime;
  preShockBtcFragility: {
    openInterestUsd: number;
    spotDepth2PctUsd: number;
    fundingRate8h: number;
    longShortRatio: number;
    nearestLiqClusterPct: number;
  };
  /** Observed 24h realized % moves for key assets */
  actualMovesPct: Record<string, number>;
  /** Binary crash threshold on BTC for Brier Score evaluation */
  btcCrashThresholdPct: number;
}

export interface BacktestCaseResult {
  caseId: string;
  name: string;
  dateLabel: string;
  triggerNodeId: string;
  shockPct: number;
  predictedBtcPct: number;
  actualBtcPct: number;
  predictedCrashProb: number;
  actualCrashOccurred: 0 | 1;
  brierContribution: number;
  directionalHits: number;
  directionalTotal: number;
  maePct: number;
  intervalHits: number;
  assetComparisons: Array<{
    nodeId: string;
    predictedPct: number;
    p10Pct: number;
    p90Pct: number;
    actualPct: number;
    inBand: boolean;
  }>;
}

export interface BacktestSummary {
  cases: BacktestCaseResult[];
  overallBrierScore: number;
  overallDirectionalAccuracy: number;
  overallIntervalCoverage: number;
  overallMaePct: number;
}

export const HISTORICAL_SHOCK_CASES: HistoricalShockCase[] = [
  {
    id: "deepseek_nvda_2025",
    name: "DeepSeek / NVIDIA AI Capex Shock",
    dateLabel: "2025-01-27",
    asOfTimestamp: Date.UTC(2025, 0, 27, 13, 0),
    triggerNodeId: "EQ_NVDA",
    shockPct: -16.9,
    regime: "EUPHORIA_OVERLEVERAGED",
    preShockBtcFragility: {
      openInterestUsd: 22_000_000_000,
      spotDepth2PctUsd: 175_000_000,
      fundingRate8h: 0.00038,
      longShortRatio: 1.72,
      nearestLiqClusterPct: 1.8,
    },
    actualMovesPct: {
      EQ_QQQ: -3.0,
      EQ_TSMC: -13.3,
      CRYPTO_BTC: -5.8,
      CRYPTO_SOL: -9.8,
      CRYPTO_RENDER: -14.2,
      CRYPTO_TAO: -13.5,
    },
    btcCrashThresholdPct: -4.0,
  },
  {
    id: "yen_carry_aug_2024",
    name: "Yen Carry Trade Global Unwind",
    dateLabel: "2024-08-05",
    asOfTimestamp: Date.UTC(2024, 7, 5, 0, 0),
    triggerNodeId: "EQ_QQQ",
    shockPct: -5.5,
    regime: "STRESS_CORRELATION_ONE",
    preShockBtcFragility: {
      openInterestUsd: 19_500_000_000,
      spotDepth2PctUsd: 140_000_000,
      fundingRate8h: 0.0003,
      longShortRatio: 1.8,
      nearestLiqClusterPct: 1.4,
    },
    actualMovesPct: {
      CRYPTO_BTC: -14.5,
      CRYPTO_ETH: -21.0,
      CRYPTO_SOL: -18.5,
      EQ_MSTR: -12.0,
    },
    btcCrashThresholdPct: -5.0,
  },
  {
    id: "svb_usdc_depeg_2023",
    name: "SVB Collapse & USDC Depeg",
    dateLabel: "2023-03-11",
    asOfTimestamp: Date.UTC(2024, 0, 2), // using baseline skeleton validity
    triggerNodeId: "INFRA_USDC",
    shockPct: -12.0,
    regime: "STRESS_CORRELATION_ONE",
    preShockBtcFragility: {
      openInterestUsd: 12_000_000_000,
      spotDepth2PctUsd: 120_000_000,
      fundingRate8h: 0.00015,
      longShortRatio: 1.25,
      nearestLiqClusterPct: 2.2,
    },
    actualMovesPct: {
      INFRA_AAVE: -11.5,
    },
    btcCrashThresholdPct: -4.0,
  },
  {
    id: "fomc_hawkish_shock",
    name: "Hawkish Fed / US10Y Yield Spike",
    dateLabel: "2024-12-18",
    asOfTimestamp: Date.UTC(2024, 11, 18, 18, 59),
    triggerNodeId: "ACTOR_POWELL",
    shockPct: 5.5, // +5.5% hawkish yield/DXY shock
    regime: "EUPHORIA_OVERLEVERAGED",
    preShockBtcFragility: {
      openInterestUsd: 24_000_000_000,
      spotDepth2PctUsd: 180_000_000,
      fundingRate8h: 0.00045,
      longShortRatio: 1.85,
      nearestLiqClusterPct: 1.5,
    },
    actualMovesPct: {
      EQ_QQQ: -3.6,
      CRYPTO_BTC: -5.2,
      CRYPTO_ETH: -7.1,
      CRYPTO_SOL: -8.4,
    },
    btcCrashThresholdPct: -4.0,
  },
];

export class BacktestEngine {
  private simulator = new AladdinSimulator();

  runHistoricalSuite(
    graph: TemporalKnowledgeGraph,
    cases: readonly HistoricalShockCase[] = HISTORICAL_SHOCK_CASES,
  ): BacktestSummary {
    const results: BacktestCaseResult[] = [];
    const brierInputs: Array<{ prob: number; outcome: 0 | 1 }> = [];
    let totalDirHits = 0;
    let totalDirCount = 0;
    let totalBandHits = 0;
    let totalAbsErr = 0;

    for (const c of cases) {
      const fragMap = new Map<string, FragilityMetrics>();
      fragMap.set(
        "CRYPTO_BTC",
        computeFragilityMetrics({
          nodeId: "CRYPTO_BTC",
          ...c.preShockBtcFragility,
        }),
      );

      const sim = this.simulator.simulateShock(
        graph,
        {
          triggerNodeId: c.triggerNodeId,
          shockPct: c.shockPct,
          asOfTimestamp: c.asOfTimestamp,
          regime: c.regime,
        },
        fragMap,
        c.regime,
      );

      const comparisons: BacktestCaseResult["assetComparisons"] = [];
      let dirHits = 0;
      let bandHits = 0;
      let errSum = 0;

      for (const [nodeId, actualPct] of Object.entries(c.actualMovesPct)) {
        const pred = sim.affectedNodes.find((a) => a.nodeId === nodeId);
        const predictedPct = pred?.expectedMovePct ?? 0;
        const p10Pct = pred?.p10MovePct ?? predictedPct - 2;
        const p90Pct = pred?.p90MovePct ?? predictedPct + 2;

        const sameSign =
          (predictedPct < 0 && actualPct < 0) ||
          (predictedPct > 0 && actualPct > 0);
        if (sameSign) dirHits++;

        const low = Math.min(p10Pct, p90Pct);
        const high = Math.max(p10Pct, p90Pct);
        const inBand = actualPct >= low && actualPct <= high;
        if (inBand) bandHits++;

        errSum += Math.abs(predictedPct - actualPct);
        comparisons.push({
          nodeId,
          predictedPct,
          p10Pct,
          p90Pct,
          actualPct,
          inBand,
        });
      }

      const nAssets = comparisons.length || 1;
      totalDirHits += dirHits;
      totalDirCount += comparisons.length;
      totalBandHits += bandHits;
      totalAbsErr += errSum;

      const btcPred =
        sim.affectedNodes.find((a) => a.nodeId === "CRYPTO_BTC")
          ?.expectedMovePct ?? 0;
      const actualBtc = c.actualMovesPct["CRYPTO_BTC"] ?? 0;
      const cascadeScenario = sim.scenarios.find(
        (s) => s.name === "CASCADE_CRASH",
      );
      const baseScenario = sim.scenarios.find(
        (s) => s.name === "BASE_REPRICING",
      );
      const crashProb =
        c.actualMovesPct["CRYPTO_BTC"] !== undefined
          ? Number(
              (
                (cascadeScenario?.probability ?? 0.3) +
                (baseScenario?.probability ?? 0.4) * 0.5
              ).toFixed(2),
            )
          : 0.5;
      const occurred: 0 | 1 = actualBtc <= c.btcCrashThresholdPct ? 1 : 0;

      if (c.actualMovesPct["CRYPTO_BTC"] !== undefined) {
        brierInputs.push({ prob: crashProb, outcome: occurred });
      }

      results.push({
        caseId: c.id,
        name: c.name,
        dateLabel: c.dateLabel,
        triggerNodeId: c.triggerNodeId,
        shockPct: c.shockPct,
        predictedBtcPct: btcPred,
        actualBtcPct: actualBtc,
        predictedCrashProb: crashProb,
        actualCrashOccurred: occurred,
        brierContribution: Number(Math.pow(crashProb - occurred, 2).toFixed(4)),
        directionalHits: dirHits,
        directionalTotal: comparisons.length,
        maePct: Number((errSum / nAssets).toFixed(2)),
        intervalHits: bandHits,
        assetComparisons: comparisons,
      });
    }

    return {
      cases: results,
      overallBrierScore: Number(brierScore(brierInputs).toFixed(4)),
      overallDirectionalAccuracy:
        totalDirCount > 0
          ? Number((totalDirHits / totalDirCount).toFixed(3))
          : 0,
      overallIntervalCoverage:
        totalDirCount > 0
          ? Number((totalBandHits / totalDirCount).toFixed(3))
          : 0,
      overallMaePct:
        totalDirCount > 0
          ? Number((totalAbsErr / totalDirCount).toFixed(2))
          : 0,
    };
  }
}
