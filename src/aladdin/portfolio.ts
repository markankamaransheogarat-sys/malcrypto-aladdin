/**
 * Portfolio Risk Overlay & DVOL-Scaled VaR Engine (Phase 4: PORTFOLIO <GO>)
 * Maps any Aladdin Contagion Simulation onto the user's actual holdings.
 */

import type { SimulationResult } from "../core/types.js";

export interface PortfolioPosition {
  nodeId: string;
  label: string;
  allocationUsd: number;
}

export interface PositionImpact {
  nodeId: string;
  label: string;
  allocationUsd: number;
  expectedMovePct: number;
  expectedPnlUsd: number;
  p10PnlUsd: number;
  p90PnlUsd: number;
}

export interface PortfolioRiskReport {
  totalUsd: number;
  expectedPnlUsd: number;
  expectedPnlPct: number;
  p10PnlUsd: number;
  p90PnlUsd: number;
  var95DailyUsd: number;
  var99DailyUsd: number;
  dvolPctUsed: number;
  positions: PositionImpact[];
  hedgeRecommendation: string;
}

export const DEFAULT_PORTFOLIO: PortfolioPosition[] = [
  { nodeId: "CRYPTO_BTC", label: "Bitcoin (BTC)", allocationUsd: 50_000 },
  { nodeId: "CRYPTO_ETH", label: "Ethereum (ETH)", allocationUsd: 20_000 },
  { nodeId: "CRYPTO_SOL", label: "Solana (SOL)", allocationUsd: 15_000 },
  { nodeId: "CRYPTO_RENDER", label: "Render (RENDER)", allocationUsd: 10_000 },
  { nodeId: "EQ_NVDA", label: "NVIDIA (NVDA)", allocationUsd: 15_000 },
];

export class PortfolioRiskEngine {
  evaluateImpact(
    positions: readonly PortfolioPosition[],
    sim: SimulationResult | null,
    dvolPct = 45,
  ): PortfolioRiskReport {
    const totalUsd = positions.reduce(
      (acc, p) => acc + Math.max(0, p.allocationUsd),
      0,
    );
    const impMap = new Map<string, { exp: number; p10: number; p90: number }>();

    if (sim) {
      impMap.set(sim.triggerNodeId, {
        exp: sim.shockPct,
        p10: sim.shockPct * 1.3,
        p90: sim.shockPct * 0.7,
      });
      for (const a of sim.affectedNodes) {
        impMap.set(a.nodeId, {
          exp: a.expectedMovePct,
          p10: a.p10MovePct,
          p90: a.p90MovePct,
        });
      }
    }

    let expectedPnlUsd = 0;
    let p10PnlUsd = 0;
    let p90PnlUsd = 0;
    const posImpacts: PositionImpact[] = [];

    for (const pos of positions) {
      const hit = impMap.get(pos.nodeId) ?? { exp: 0, p10: 0, p90: 0 };
      const expUsd = (pos.allocationUsd * hit.exp) / 100;
      const p10Usd = (pos.allocationUsd * hit.p10) / 100;
      const p90Usd = (pos.allocationUsd * hit.p90) / 100;

      expectedPnlUsd += expUsd;
      p10PnlUsd += Math.min(p10Usd, p90Usd);
      p90PnlUsd += Math.max(p10Usd, p90Usd);

      posImpacts.push({
        nodeId: pos.nodeId,
        label: pos.label,
        allocationUsd: pos.allocationUsd,
        expectedMovePct: Number(hit.exp.toFixed(2)),
        expectedPnlUsd: Number(expUsd.toFixed(0)),
        p10PnlUsd: Number(Math.min(p10Usd, p90Usd).toFixed(0)),
        p90PnlUsd: Number(Math.max(p10Usd, p90Usd).toFixed(0)),
      });
    }

    // Parametric 1-day VaR scaled by live Deribit DVOL
    const dailySigma = dvolPct / 100 / Math.sqrt(365);
    const var95DailyUsd = Number((totalUsd * 1.645 * dailySigma).toFixed(0));
    const var99DailyUsd = Number((totalUsd * 2.326 * dailySigma).toFixed(0));
    const expectedPnlPct =
      totalUsd > 0 ? Number(((expectedPnlUsd / totalUsd) * 100).toFixed(2)) : 0;

    // Worst-hit asset for hedge guidance
    const worst = [...posImpacts].sort(
      (a, b) => a.expectedPnlUsd - b.expectedPnlUsd,
    )[0];
    let hedgeRecommendation =
      "Portfolio drawdown within normal daily VaR bounds. No emergency hedge required.";
    if (expectedPnlPct <= -5 && worst) {
      hedgeRecommendation = `HIGH DOWNSIDE (${expectedPnlPct}%): Consider hedging ${Math.min(50, Math.round(Math.abs(expectedPnlPct) * 3))}% beta via BTC/QQQ short perp or trimming ${worst.label} (${worst.expectedMovePct}%).`;
    } else if (expectedPnlPct <= -2.5 && worst) {
      hedgeRecommendation = `MODERATE RISK (${expectedPnlPct}%): Tighten stops on ${worst.label} and monitor funding/OI clusters.`;
    }

    return {
      totalUsd,
      expectedPnlUsd: Number(expectedPnlUsd.toFixed(0)),
      expectedPnlPct,
      p10PnlUsd: Number(p10PnlUsd.toFixed(0)),
      p90PnlUsd: Number(p90PnlUsd.toFixed(0)),
      var95DailyUsd,
      var99DailyUsd,
      dvolPctUsed: dvolPct,
      positions: posImpacts.sort((a, b) => a.expectedPnlUsd - b.expectedPnlUsd),
      hedgeRecommendation,
    };
  }
}
