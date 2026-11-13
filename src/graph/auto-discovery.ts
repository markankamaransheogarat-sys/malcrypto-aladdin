/**
 * Autonomous Graph Node Discovery (Phase 3)
 * Discovers new market actors, protocols, and narratives from GDELT news,
 * Polymarket questions, and DeFiLlama top protocols without manual curation.
 */

import { clamp } from "../core/math.js";
import type { GraphEdge, GraphNode, NodeTier } from "../core/types.js";
import type { TemporalKnowledgeGraph } from "./temporal-graph.js";

const STOP_WORDS = new Set([
  "The",
  "This",
  "That",
  "With",
  "From",
  "After",
  "Before",
  "Under",
  "Over",
  "Into",
  "About",
  "Amid",
  "Says",
  "Will",
  "Could",
  "Would",
  "Should",
  "Market",
  "Markets",
  "Crypto",
  "Stock",
  "Stocks",
  "Price",
  "Prices",
  "Report",
  "News",
  "Update",
  "Today",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
  "Sunday",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
  "United",
  "States",
  "Global",
  "Breaking",
  "Watch",
  "Live",
  "Analysis",
  "Why",
  "How",
  "What",
  "When",
  "Where",
]);

export interface DiscoveredProtocol {
  name: string;
  symbol: string;
  tvlUsd: number;
  category: string;
}

export class AutoGraphExpander {
  /**
   * Extracts candidate Proper-Noun entities from news headlines that are not yet in the graph,
   * creates new nodes, and links them to co-occurring graph nodes.
   */
  discoverFromHeadline(
    graph: TemporalKnowledgeGraph,
    title: string,
    matchedExistingIds: string[],
    timestamp = Date.now(),
  ): { newNodes: GraphNode[]; newEdges: GraphEdge[] } {
    const newNodes: GraphNode[] = [];
    const newEdges: GraphEdge[] = [];

    // Match capitalized words/phrases (e.g., "DeepSeek", "Hyperliquid", "Circle IPO", "Trump")
    const candidates =
      title.match(/\b[A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]{2,})?\b/g) ??
      [];
    const existingNodes = graph.getAllNodes();

    for (const raw of candidates) {
      const clean = raw.trim();
      if (STOP_WORDS.has(clean)) continue;
      const firstWord = clean.split(/\s+/)[0];
      if (STOP_WORDS.has(firstWord)) continue;

      const lower = clean.toLowerCase();
      const alreadyExists = existingNodes.some(
        (n) =>
          n.label.toLowerCase().includes(lower) ||
          n.aliases.some((a) => a.toLowerCase() === lower),
      );
      if (alreadyExists) continue;

      const id = `AUTO_${clean.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      if (graph.getNode(id)) continue;

      const tier: NodeTier = inferTier(lower, title.toLowerCase());
      const node: GraphNode = {
        id,
        label: clean,
        tier,
        sector: "Auto-Discovered",
        aliases: [lower],
        systemicWeight: 0.62,
        description: `Auto-discovered from headline: "${title.slice(0, 90)}"`,
      };
      graph.addNode(node);
      newNodes.push(node);

      // Link to co-occurring known nodes
      for (const targetId of matchedExistingIds.slice(0, 2)) {
        const edge: GraphEdge = {
          id: `${id}__NARRATIVE_PROXY__${targetId}`,
          source: id,
          target: targetId,
          relation: "NARRATIVE_PROXY",
          weight: 0.45,
          stressWeight: 0.68,
          lagMinutes: 15,
          polarity: 1,
          confidence: 0.55,
          origin: "NEWS_HYPOTHESIS",
          validFrom: timestamp,
          validTo: null,
          evidence: `Auto-discovered co-occurrence in "${title.slice(0, 70)}"`,
        };
        graph.upsertEdge(edge);
        newEdges.push(edge);
      }
      // Limit to max 2 new nodes per headline to avoid noise explosion
      if (newNodes.length >= 2) break;
    }

    return { newNodes, newEdges };
  }

  /**
   * Registers top DeFiLlama protocols above TVL threshold as INFRA_STABLE nodes.
   */
  ingestTopProtocols(
    graph: TemporalKnowledgeGraph,
    protocols: readonly DiscoveredProtocol[],
    minTvlUsd = 1_500_000_000,
    timestamp = Date.now(),
  ): number {
    let added = 0;
    const existing = graph.getAllNodes();

    for (const p of protocols) {
      if (p.tvlUsd < minTvlUsd) continue;
      const lowerName = p.name.toLowerCase();
      const lowerSym = p.symbol.toLowerCase();
      const exists = existing.some(
        (n) =>
          n.label.toLowerCase().includes(lowerName) ||
          n.aliases.some(
            (a) => a === lowerName || (lowerSym.length >= 2 && a === lowerSym),
          ),
      );
      if (exists) continue;

      const id = `PROTO_${p.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;
      if (graph.getNode(id)) continue;

      graph.addNode({
        id,
        label: p.symbol ? `${p.name} (${p.symbol})` : p.name,
        ticker: p.symbol || undefined,
        tier: "INFRA_STABLE",
        sector: p.category || "DeFi Protocol",
        aliases: [lowerName, ...(lowerSym.length >= 2 ? [lowerSym] : [])],
        systemicWeight: Number(
          clamp(0.55 + Math.log10(p.tvlUsd / 1e9) * 0.15, 0.55, 0.88).toFixed(
            2,
          ),
        ),
        description: `DeFiLlama TVL: $${(p.tvlUsd / 1e9).toFixed(2)}B (${p.category})`,
      });

      graph.upsertEdge({
        id: `CRYPTO_ETH__COLLATERAL_LINK__${id}`,
        source: "CRYPTO_ETH",
        target: id,
        relation: "COLLATERAL_LINK",
        weight: 0.65,
        stressWeight: 0.85,
        lagMinutes: 10,
        polarity: 1,
        confidence: 0.72,
        origin: "SKELETON",
        validFrom: timestamp,
        validTo: null,
        evidence: `DeFiLlama TVL $${(p.tvlUsd / 1e9).toFixed(2)}B`,
      });
      added++;
      if (added >= 6) break;
    }
    return added;
  }
}

function inferTier(entityLower: string, contextLower: string): NodeTier {
  if (
    /capital|ventures|fund|partners|bank|treasury|ministry|court|trump|biden|musk/.test(
      entityLower + " " + contextLower,
    )
  ) {
    return "ACTOR";
  }
  if (/ai|protocol|swap|chain|network|token|coin/.test(contextLower)) {
    return "CRYPTO_ASSET";
  }
  return "MACRO_EQUITY";
}
