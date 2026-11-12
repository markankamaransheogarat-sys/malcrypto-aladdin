/**
 * Online Causal & Lead-Lag Discovery Engine
 * Discovers directed price dependencies across equities, macro, and crypto
 * using Granger Causality + Tail Beta + Benjamini-Hochberg FDR control.
 */

import {
  benjaminiHochbergFDR,
  clamp,
  grangerCausalityTest,
  laggedCorrelation,
  tailBeta,
} from "../core/math.js";
import type { CausalDiscoveryResult, GraphEdge } from "../core/types.js";
import type { TemporalKnowledgeGraph } from "../graph/temporal-graph.js";

export interface DiscoveryOptions {
  barMinutes?: number;
  maxLagSteps?: number;
  fdrAlpha?: number;
  minSampleSize?: number;
}

export class CausalDiscoveryEngine {
  /**
   * Scans return series across nodes, identifies statistically significant
   * lead-lag causal links, and returns FDR-filtered discoveries.
   */
  discoverLinks(
    seriesByNode: ReadonlyMap<string, readonly number[]>,
    options: DiscoveryOptions = {},
  ): CausalDiscoveryResult[] {
    const barMinutes = options.barMinutes ?? 15;
    const maxLagSteps = options.maxLagSteps ?? 4;
    const fdrAlpha = options.fdrAlpha ?? 0.05;
    const minSampleSize = options.minSampleSize ?? 30;

    const nodeIds = Array.from(seriesByNode.keys());
    const rawCandidates: Omit<CausalDiscoveryResult, "fdrSignificant">[] = [];

    for (let i = 0; i < nodeIds.length; i++) {
      const source = nodeIds[i];
      const x = seriesByNode.get(source)!;
      if (x.length < minSampleSize) continue;

      for (let j = 0; j < nodeIds.length; j++) {
        if (i === j) continue;
        const target = nodeIds[j];
        const y = seriesByNode.get(target)!;
        const n = Math.min(x.length, y.length);
        if (n < minSampleSize) continue;

        let bestLag = 1;
        let bestF = 0;
        let bestP = 1;
        let bestCorr = 0;

        for (let lag = 1; lag <= maxLagSteps; lag++) {
          const { fStat, pValue } = grangerCausalityTest(x, y, lag);
          const corr = laggedCorrelation(x, y, lag);
          if (fStat > bestF) {
            bestF = fStat;
            bestP = pValue;
            bestLag = lag;
            bestCorr = corr;
          }
        }

        const tb = tailBeta(x, y, 1.5);
        const polarity: 1 | -1 = bestCorr >= 0 ? 1 : -1;

        rawCandidates.push({
          source,
          target,
          optimalLagSteps: bestLag,
          lagMinutes: bestLag * barMinutes,
          correlation: Number(bestCorr.toFixed(3)),
          grangerFStat: Number(bestF.toFixed(3)),
          pValue: Number(bestP.toFixed(5)),
          tailBetaDownside: Number(tb.toFixed(3)),
          polarity,
          sampleSize: n,
        });
      }
    }

    const pValues = rawCandidates.map((c) => c.pValue);
    const sigFlags = benjaminiHochbergFDR(pValues, fdrAlpha);

    return rawCandidates
      .map((c, idx) => ({
        ...c,
        fdrSignificant: sigFlags[idx],
      }))
      .sort((a, b) => a.pValue - b.pValue);
  }

  /**
   * Synchronizes FDR-significant causal discoveries into the Bi-Temporal Graph.
   */
  syncDiscoveriesToGraph(
    graph: TemporalKnowledgeGraph,
    discoveries: readonly CausalDiscoveryResult[],
    now = Date.now(),
  ): number {
    let upserted = 0;
    for (const d of discoveries) {
      if (!d.fdrSignificant || Math.abs(d.correlation) < 0.2) continue;

      const weight = clamp(Math.abs(d.correlation) * 0.9, 0.25, 0.95);
      const stressWeight = clamp(
        Math.max(weight, Math.abs(d.tailBetaDownside) * 0.55),
        weight,
        1.25,
      );
      const confidence = clamp(1 - d.pValue * 5, 0.5, 0.99);

      const edge: GraphEdge = {
        id: `${d.source}__CAUSAL_LAG__${d.target}`,
        source: d.source,
        target: d.target,
        relation: "CAUSAL_LAG",
        weight: Number(weight.toFixed(2)),
        stressWeight: Number(stressWeight.toFixed(2)),
        lagMinutes: d.lagMinutes,
        polarity: d.polarity,
        confidence: Number(confidence.toFixed(2)),
        origin: "CAUSAL_ENGINE",
        validFrom: now,
        validTo: null,
        evidence: `Granger F=${d.grangerFStat}, p=${d.pValue}, TailBeta=${d.tailBetaDownside}, lag=${d.lagMinutes}m`,
      };

      graph.upsertEdge(edge);
      upserted++;
    }
    return upserted;
  }
}
