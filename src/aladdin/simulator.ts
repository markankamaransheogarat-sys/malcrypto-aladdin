/**
 * Aladdin Risk, Contagion & Scenario Simulation Engine
 * Produces probability-weighted Scenario Trees (P10/P50/P90) and tracks Brier Score calibration.
 */

import { brierScore, clamp } from "../core/math.js";
import type {
  CalibrationReport,
  FragilityMetrics,
  MarketRegime,
  NewsEvent,
  PredictionRecord,
  ScenarioBranch,
  ShockInput,
  SimulationResult,
} from "../core/types.js";
import type { TemporalKnowledgeGraph } from "../graph/temporal-graph.js";

export class AladdinSimulator {
  /**
   * Simulates a structural or price shock across the Bi-Temporal Graph.
   */
  simulateShock(
    graph: TemporalKnowledgeGraph,
    input: ShockInput,
    fragilityMap: Map<string, FragilityMetrics>,
    detectedRegime: MarketRegime = "RISK_ON_CALM",
  ): SimulationResult {
    const regime = input.regime ?? detectedRegime;
    const triggerNode = graph.getNode(input.triggerNodeId);
    const affected = graph.propagateShock(input, fragilityMap, regime, 4);

    const maxCascadeDepth = affected.reduce((mx, n) => Math.max(mx, n.hop), 0);

    // Find BTC impact (either direct trigger or propagated)
    const btcResult =
      input.triggerNodeId === "CRYPTO_BTC"
        ? { expectedMovePct: input.shockPct, p10MovePct: input.shockPct * 1.35 }
        : affected.find((a) => a.nodeId === "CRYPTO_BTC");

    const btcExpected = btcResult?.expectedMovePct ?? 0;
    const btcFragility = fragilityMap.get("CRYPTO_BTC")?.fragilityScore ?? 45;

    // Systemic risk score [0..100]
    const totalMoveMass = affected.reduce(
      (acc, n) => acc + Math.abs(n.expectedMovePct),
      0,
    );
    const totalSystemicRiskScore = Math.round(
      clamp(totalMoveMass * 0.65 + (btcFragility / 100) * 25, 0, 100),
    );

    const scenarios = this.buildScenarioTree(
      input.shockPct,
      btcExpected,
      btcFragility,
      regime,
    );

    return {
      id: `sim_${Date.now()}_${input.triggerNodeId}`,
      timestamp: input.asOfTimestamp ?? Date.now(),
      triggerNodeId: input.triggerNodeId,
      triggerLabel: triggerNode?.label ?? input.triggerNodeId,
      shockPct: input.shockPct,
      regime,
      affectedNodes: affected,
      scenarios,
      maxCascadeDepth,
      totalSystemicRiskScore,
    };
  }

  /**
   * Converts a parsed NewsEvent into a ShockInput and runs simulation if impactful.
   */
  simulateFromNews(
    graph: TemporalKnowledgeGraph,
    event: NewsEvent,
    fragilityMap: Map<string, FragilityMetrics>,
    regime: MarketRegime,
  ): SimulationResult | null {
    if (
      event.matchedNodes.length === 0 ||
      Math.abs(event.surpriseScore) < 0.15
    ) {
      return null;
    }

    // Pick highest systemicWeight matched node as primary epicenter
    const centrality = graph.computeCentrality(event.timestamp);
    const primaryNodeId = [...event.matchedNodes].sort((a, b) => {
      const sa =
        (graph.getNode(a)?.systemicWeight ?? 0) +
        (centrality.get(a) ?? 0) * 0.05;
      const sb =
        (graph.getNode(b)?.systemicWeight ?? 0) +
        (centrality.get(b) ?? 0) * 0.05;
      return sb - sa;
    })[0];

    // Translate surprise [-1..+1] and trustScore [0..1] into initial shock %
    const baseMagnitude = event.category === "HACK_EXPLOIT" ? 14 : 8.5;
    const shockPct = Number(
      (
        event.surpriseScore *
        baseMagnitude *
        clamp(event.trustScore, 0.4, 1)
      ).toFixed(2),
    );

    return this.simulateShock(
      graph,
      {
        triggerNodeId: primaryNodeId,
        shockPct,
        surpriseMultiplier: 1.0,
        asOfTimestamp: event.timestamp,
        regime,
      },
      fragilityMap,
      regime,
    );
  }

  private buildScenarioTree(
    triggerShockPct: number,
    btcExpectedPct: number,
    btcFragility: number,
    regime: MarketRegime,
  ): ScenarioBranch[] {
    const isNegative = triggerShockPct < 0;
    const absShock = Math.abs(triggerShockPct);

    // Probability of severe cascade rises with fragility, shock size, and stress regime
    const regimeBoost =
      regime === "STRESS_CORRELATION_ONE"
        ? 0.14
        : regime === "EUPHORIA_OVERLEVERAGED"
          ? 0.09
          : 0;

    let cascadeProb = clamp(
      0.16 + (btcFragility / 100) * 0.25 + (absShock / 20) * 0.22 + regimeBoost,
      0.12,
      0.65,
    );
    let absorptionProb = clamp(
      0.28 - (absShock / 25) * 0.12 - regimeBoost * 0.5,
      0.1,
      0.35,
    );
    let baseProb = clamp(1 - cascadeProb - absorptionProb, 0.15, 0.75);

    // Normalize exactly to 1.00
    const sum = cascadeProb + baseProb + absorptionProb;
    cascadeProb = Number((cascadeProb / sum).toFixed(2));
    absorptionProb = Number((absorptionProb / sum).toFixed(2));
    baseProb = Number((1 - cascadeProb - absorptionProb).toFixed(2));

    const cascadeMult = isNegative ? 1.65 : 1.45;
    const btcBase = Number(btcExpectedPct.toFixed(2));
    const btcCascade = Number((btcExpectedPct * cascadeMult).toFixed(2));
    const btcAbsorption = Number((-btcExpectedPct * 0.35).toFixed(2));

    return [
      {
        name: "BASE_REPRICING",
        label: isNegative
          ? "Base Risk-Off Repricing"
          : "Base Risk-On Repricing",
        probability: baseProb,
        horizonHours: 6,
        btcExpectedPct: btcBase,
        triggerCondition:
          "Normal orderbook absorption without major liquidation breach",
      },
      {
        name: "CASCADE_CRASH",
        label: isNegative
          ? "Liquidation Cascade (Tail)"
          : "Short-Squeeze Cascade (Tail)",
        probability: cascadeProb,
        horizonHours: 12,
        btcExpectedPct: btcCascade,
        triggerCondition: `Breach of nearest OI cluster (Fragility ${btcFragility}/100, Regime ${regime})`,
      },
      {
        name: "ABSORPTION_REVERSAL",
        label: "Spot Absorption / Fade",
        probability: absorptionProb,
        horizonHours: 4,
        btcExpectedPct: btcAbsorption,
        triggerCondition:
          "Aggressive spot limit bids/asks absorb initial impulse",
      },
    ];
  }
}

export class CalibrationTracker {
  private records: PredictionRecord[] = [];

  recordPrediction(pred: PredictionRecord): void {
    this.records.push({ ...pred });
  }

  resolvePrediction(
    id: string,
    actualMovePct: number,
    resolvedAt = Date.now(),
  ): PredictionRecord | undefined {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;

    const occurred: 0 | 1 =
      rec.thresholdPct < 0
        ? actualMovePct <= rec.thresholdPct
          ? 1
          : 0
        : actualMovePct >= rec.thresholdPct
          ? 1
          : 0;

    rec.resolvedAt = resolvedAt;
    rec.actualMovePct = actualMovePct;
    rec.outcomeOccurred = occurred;
    rec.brierContribution = Number(
      Math.pow(clamp(rec.predictedCrashProb, 0, 1) - occurred, 2).toFixed(4),
    );
    return rec;
  }

  getRecords(): PredictionRecord[] {
    return [...this.records];
  }

  getReport(): CalibrationReport {
    const resolved = this.records.filter(
      (r) => r.outcomeOccurred !== undefined,
    );
    if (resolved.length === 0) {
      return {
        totalPredictions: this.records.length,
        resolvedCount: 0,
        brierScore: 0,
        hitRate: 0,
        avgPredictedProb: 0,
      };
    }

    const bs = brierScore(
      resolved.map((r) => ({
        prob: r.predictedCrashProb,
        outcome: r.outcomeOccurred!,
      })),
    );
    const hits = resolved.filter((r) => r.outcomeOccurred === 1).length;
    const avgProb =
      resolved.reduce((acc, r) => acc + r.predictedCrashProb, 0) /
      resolved.length;

    return {
      totalPredictions: this.records.length,
      resolvedCount: resolved.length,
      brierScore: Number(bs.toFixed(4)),
      hitRate: Number((hits / resolved.length).toFixed(3)),
      avgPredictedProb: Number(avgProb.toFixed(3)),
    };
  }
}
