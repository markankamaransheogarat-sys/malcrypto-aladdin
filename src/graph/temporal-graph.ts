/**
 * Bi-Temporal Knowledge Graph Engine
 * Supports time-travel queries (no look-ahead bias), automatic edge pruning,
 * centrality scoring, and multi-hop shock propagation.
 */

import { clamp } from "../core/math.js";
import type {
  ContagionNodeResult,
  FragilityMetrics,
  GraphEdge,
  GraphNode,
  MarketRegime,
  ShockInput,
} from "../core/types.js";
import { SEED_EDGES, SEED_NODES } from "./skeleton.js";

export interface GraphSnapshot {
  version: number;
  exportedAt: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export class TemporalKnowledgeGraph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge>();

  constructor(loadSeed = true) {
    if (loadSeed) {
      for (const n of SEED_NODES) this.addNode(n);
      for (const e of SEED_EDGES) this.upsertEdge(e);
    }
  }

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, { ...node, aliases: [...node.aliases] });
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  updateNodeMarketData(
    id: string,
    patch: Partial<
      Pick<GraphNode, "price" | "change24hPct" | "fragilityScore">
    >,
  ): void {
    const existing = this.nodes.get(id);
    if (!existing) return;
    this.nodes.set(id, { ...existing, ...patch });
  }

  upsertEdge(edge: GraphEdge): void {
    this.edges.set(edge.id, { ...edge });
  }

  /**
   * Bi-temporal expiration: marks an edge inactive from `timestamp` without deleting history.
   */
  expireEdge(edgeId: string, timestamp = Date.now()): boolean {
    const existing = this.edges.get(edgeId);
    if (!existing || existing.validTo !== null) return false;
    this.edges.set(edgeId, { ...existing, validTo: timestamp });
    return true;
  }

  /**
   * Returns only edges valid at `asOfTimestamp` (prevents look-ahead bias in backtests).
   */
  getActiveEdges(asOfTimestamp = Date.now()): GraphEdge[] {
    const result: GraphEdge[] = [];
    for (const e of this.edges.values()) {
      if (
        e.validFrom <= asOfTimestamp &&
        (e.validTo === null || e.validTo > asOfTimestamp)
      ) {
        result.push(e);
      }
    }
    return result;
  }

  getAllEdgesHistorical(): GraphEdge[] {
    return Array.from(this.edges.values());
  }

  getOutgoingEdges(nodeId: string, asOfTimestamp = Date.now()): GraphEdge[] {
    return this.getActiveEdges(asOfTimestamp).filter(
      (e) => e.source === nodeId,
    );
  }

  getIncomingEdges(nodeId: string, asOfTimestamp = Date.now()): GraphEdge[] {
    return this.getActiveEdges(asOfTimestamp).filter(
      (e) => e.target === nodeId,
    );
  }

  /**
   * Prunes statistically dead or low-confidence discovered edges (FDR / Gardener step).
   */
  pruneWeakEdges(minConfidence = 0.45, now = Date.now()): number {
    let pruned = 0;
    for (const e of this.edges.values()) {
      if (
        e.validTo === null &&
        e.origin !== "SKELETON" &&
        e.confidence < minConfidence
      ) {
        this.edges.set(e.id, { ...e, validTo: now });
        pruned++;
      }
    }
    return pruned;
  }

  /**
   * Computes weighted systemic centrality for every node at `asOfTimestamp`.
   */
  computeCentrality(asOfTimestamp = Date.now()): Map<string, number> {
    const active = this.getActiveEdges(asOfTimestamp);
    const scores = new Map<string, number>();
    for (const n of this.nodes.keys()) scores.set(n, 0);

    for (const e of active) {
      scores.set(e.source, (scores.get(e.source) ?? 0) + e.weight * 1.2);
      scores.set(e.target, (scores.get(e.target) ?? 0) + e.weight * 0.6);
    }
    return scores;
  }

  /**
   * Multi-hop Contagion / Shock Propagation across the Bi-Temporal Graph.
   * Uses strongest-path BFS with cycle prevention, regime weighting, and fragility amplification.
   */
  propagateShock(
    input: ShockInput,
    fragilityMap: Map<string, FragilityMetrics>,
    regime: MarketRegime = "RISK_ON_CALM",
    maxHops = 4,
  ): ContagionNodeResult[] {
    const asOf = input.asOfTimestamp ?? Date.now();
    const surpriseMult = clamp(input.surpriseMultiplier ?? 1.0, 0.4, 2.0);
    const trigger = this.nodes.get(input.triggerNodeId);
    if (!trigger) return [];

    const activeEdges = this.getActiveEdges(asOf);
    const adj = new Map<string, GraphEdge[]>();
    for (const e of activeEdges) {
      const list = adj.get(e.source) ?? [];
      list.push(e);
      adj.set(e.source, list);
    }

    interface QueueItem {
      nodeId: string;
      shockPct: number;
      hop: number;
      etaMinutes: number;
      path: string[];
    }

    const bestImpact = new Map<string, ContagionNodeResult>();
    const queue: QueueItem[] = [
      {
        nodeId: input.triggerNodeId,
        shockPct: input.shockPct * surpriseMult,
        hop: 0,
        etaMinutes: 0,
        path: [input.triggerNodeId],
      },
    ];

    const regimeDecay = regime === "STRESS_CORRELATION_ONE" ? 0.92 : 0.82;

    while (queue.length > 0) {
      const curr = queue.shift()!;
      if (curr.hop >= maxHops) continue;

      const outgoing = adj.get(curr.nodeId) ?? [];
      for (const e of outgoing) {
        if (curr.path.includes(e.target)) continue; // cycle guard
        const targetNode = this.nodes.get(e.target);
        if (!targetNode) continue;

        const baseWeight =
          regime === "STRESS_CORRELATION_ONE" ? e.stressWeight : e.weight;

        const frag = fragilityMap.get(e.target);
        const fragScore =
          frag?.fragilityScore ?? targetNode.fragilityScore ?? 35;
        // Downside shocks get amplified by market leverage/fragility
        const isDownsideOnTarget = curr.shockPct * e.polarity < 0;
        const fragilityAmp = isDownsideOnTarget
          ? 1 + (fragScore / 100) * 0.55
          : 1 + (fragScore / 100) * 0.15;

        const nextShock =
          curr.shockPct * e.polarity * baseWeight * regimeDecay * fragilityAmp;

        if (Math.abs(nextShock) < 0.25) continue; // ignore negligible noise

        const nextHop = curr.hop + 1;
        const nextEta = curr.etaMinutes + e.lagMinutes;
        const nextPath = [...curr.path, e.target];

        // Uncertainty widens with hop depth and volatility
        const volSpread = Math.abs(nextShock) * (0.28 + nextHop * 0.12);
        const p50 = nextShock;
        const p10 = nextShock - volSpread;
        const p90 = nextShock + volSpread * 0.75;

        const prev = bestImpact.get(e.target);
        if (!prev || Math.abs(nextShock) > Math.abs(prev.expectedMovePct)) {
          bestImpact.set(e.target, {
            nodeId: e.target,
            label: targetNode.label,
            tier: targetNode.tier,
            hop: nextHop,
            etaMinutes: nextEta,
            expectedMovePct: Number(nextShock.toFixed(2)),
            p10MovePct: Number(p10.toFixed(2)),
            p50MovePct: Number(p50.toFixed(2)),
            p90MovePct: Number(p90.toFixed(2)),
            path: nextPath,
            fragilityAmplifier: Number(fragilityAmp.toFixed(2)),
          });

          queue.push({
            nodeId: e.target,
            shockPct: nextShock,
            hop: nextHop,
            etaMinutes: nextEta,
            path: nextPath,
          });
        }
      }
    }

    return Array.from(bestImpact.values()).sort(
      (a, b) => Math.abs(b.expectedMovePct) - Math.abs(a.expectedMovePct),
    );
  }

  exportSnapshot(): GraphSnapshot {
    return {
      version: 1,
      exportedAt: Date.now(),
      nodes: this.getAllNodes(),
      edges: this.getAllEdgesHistorical(),
    };
  }

  importSnapshot(snapshot: GraphSnapshot): void {
    this.nodes.clear();
    this.edges.clear();
    for (const n of snapshot.nodes) this.addNode(n);
    for (const e of snapshot.edges) this.upsertEdge(e);
  }
}
