/**
 * News-to-Graph Linker, Trust Scorer & Surprise Engine
 * Zero-cost algorithmic NLP (EN + RU) with Pluggable AI adapter support.
 */

import { clamp } from "../core/math.js";
import type { GraphEdge, NewsEvent } from "../core/types.js";
import type { TemporalKnowledgeGraph } from "../graph/temporal-graph.js";

const SOURCE_TRUST_MAP: Record<string, number> = {
  "sec.gov": 0.99,
  "federalreserve.gov": 0.99,
  reuters: 0.93,
  bloomberg: 0.93,
  coindesk: 0.85,
  "the block": 0.86,
  cointelegraph: 0.78,
  polymarket: 0.88,
  gdelt: 0.8,
  "tree news": 0.82,
  "walter bloomberg": 0.8,
  telegram_rumour: 0.35,
};

const BULLISH_TERMS: Record<string, number> = {
  surge: 0.7,
  rally: 0.7,
  beat: 0.8,
  beats: 0.8,
  approved: 0.9,
  approval: 0.9,
  inflow: 0.7,
  inflows: 0.7,
  "cuts rates": 0.85,
  "rate cut": 0.85,
  dovish: 0.75,
  partnership: 0.6,
  accumulation: 0.7,
  minted: 0.5,
  "record high": 0.8,
  "guidance raised": 0.9,
  рост: 0.7,
  одобрил: 0.9,
  приток: 0.7,
  "снижение ставки": 0.85,
  прорыв: 0.65,
};

const BEARISH_TERMS: Record<string, number> = {
  crash: 0.9,
  plunge: 0.85,
  collapse: 0.95,
  hack: 0.95,
  hacked: 0.95,
  exploit: 0.95,
  lawsuit: 0.85,
  sued: 0.85,
  "sec charges": 0.9,
  ban: 0.85,
  sanctions: 0.85,
  miss: 0.75,
  misses: 0.75,
  "guidance cut": 0.9,
  warning: 0.75,
  slowdown: 0.75,
  restriction: 0.8,
  "export control": 0.85,
  depeg: 0.95,
  outflow: 0.7,
  outflows: 0.7,
  hawkish: 0.75,
  "rate hike": 0.85,
  liquidation: 0.75,
  insolvency: 0.95,
  bankrupt: 0.95,
  рухнул: 0.9,
  обвал: 0.9,
  взлом: 0.95,
  иск: 0.85,
  отток: 0.7,
  запрет: 0.85,
  ограничения: 0.8,
  падение: 0.75,
  "снизил прогноз": 0.85,
};

export class NewsLinkerEngine {
  /**
   * Resolves entities in raw news text against the Knowledge Graph,
   * computes sentiment, trust score, category, and surprise vs market consensus.
   */
  analyzeNews(
    graph: TemporalKnowledgeGraph,
    params: {
      id: string;
      title: string;
      source: string;
      url?: string;
      timestamp?: number;
      /** Optional market prior probability [0..1] for positive outcome (e.g. from Polymarket) */
      marketPriorPositiveProb?: number;
      corroboratingSourcesCount?: number;
    },
  ): NewsEvent {
    const lower = params.title.toLowerCase();
    const matchedNodes: string[] = [];

    for (const node of graph.getAllNodes()) {
      const hit = node.aliases.some((alias) => {
        const a = alias.toLowerCase();
        // Word-boundary check for short tickers like "sec", "sol", "ai", "btc"
        if (a.length <= 4) {
          const re = new RegExp(
            `(^|[^a-zа-я0-9])${escapeRegExp(a)}([^a-zа-я0-9]|$)`,
            "i",
          );
          return re.test(lower);
        }
        return lower.includes(a);
      });
      if (hit) matchedNodes.push(node.id);
    }

    // Sentiment scoring
    let bull = 0;
    let bear = 0;
    for (const [term, w] of Object.entries(BULLISH_TERMS)) {
      if (lower.includes(term)) bull += w;
    }
    for (const [term, w] of Object.entries(BEARISH_TERMS)) {
      if (lower.includes(term)) bear += w;
    }
    const rawSentiment = clamp(
      (bull - bear) / Math.max(1, bull + bear + 0.5),
      -1,
      1,
    );

    // Surprise = Actual - Expected
    // If market expected 85% bullish (prior = 0.85 -> expected sentiment +0.7) and news is negative (-0.8),
    // surprise is huge (-1.5 -> clamped -1.0). If news is merely mildly positive (+0.2), surprise is negative!
    let surpriseScore = rawSentiment;
    if (params.marketPriorPositiveProb !== undefined) {
      const expectedSentiment =
        (clamp(params.marketPriorPositiveProb, 0, 1) - 0.5) * 2;
      surpriseScore = clamp(rawSentiment - expectedSentiment * 0.65, -1, 1);
    }

    const srcKey = params.source.toLowerCase();
    let trustScore = 0.55;
    for (const [k, v] of Object.entries(SOURCE_TRUST_MAP)) {
      if (srcKey.includes(k)) {
        trustScore = v;
        break;
      }
    }

    const corrCount = params.corroboratingSourcesCount ?? 1;
    let status: NewsEvent["status"] = "RUMOUR";
    if (trustScore >= 0.85) status = "VERIFIED";
    else if (corrCount >= 2 || trustScore >= 0.72) status = "CORROBORATED";

    const category = classifyCategory(lower);

    return {
      id: params.id,
      timestamp: params.timestamp ?? Date.now(),
      title: params.title,
      source: params.source,
      url: params.url,
      trustScore: Number(trustScore.toFixed(2)),
      matchedNodes,
      sentiment: Number(rawSentiment.toFixed(2)),
      surpriseScore: Number(surpriseScore.toFixed(2)),
      category,
      status,
    };
  }

  /**
   * Auto-discovers hypothetical edges when 2+ entities co-occur in verified/corroborated news
   * and lack an active direct edge in the graph.
   */
  proposeHypothesesFromNews(
    graph: TemporalKnowledgeGraph,
    event: NewsEvent,
  ): GraphEdge[] {
    if (event.status === "RUMOUR" || event.matchedNodes.length < 2) return [];
    const created: GraphEdge[] = [];
    const active = graph.getActiveEdges(event.timestamp);

    for (let i = 0; i < event.matchedNodes.length; i++) {
      for (let j = i + 1; j < event.matchedNodes.length; j++) {
        const a = event.matchedNodes[i];
        const b = event.matchedNodes[j];
        const exists = active.some(
          (e) =>
            (e.source === a && e.target === b) ||
            (e.source === b && e.target === a),
        );
        if (exists) continue;

        const edge: GraphEdge = {
          id: `${a}__NARRATIVE_PROXY__${b}`,
          source: a,
          target: b,
          relation: "NARRATIVE_PROXY",
          weight: 0.42,
          stressWeight: 0.65,
          lagMinutes: 15,
          polarity: 1,
          confidence: clamp(event.trustScore * 0.6, 0.35, 0.7),
          origin: "NEWS_HYPOTHESIS",
          validFrom: event.timestamp,
          validTo: null,
          evidence: `Co-occurred in ${event.source}: "${event.title.slice(0, 80)}"`,
        };
        graph.upsertEdge(edge);
        created.push(edge);
      }
    }
    return created;
  }
}

function classifyCategory(lower: string): NewsEvent["category"] {
  if (/hack|exploit|drained|breach|взлом/.test(lower)) return "HACK_EXPLOIT";
  if (/sec|cftc|lawsuit|sued|etf|ban|sanction|регулятор|иск/.test(lower))
    return "REGULATION";
  if (/fed|fomc|powell|cpi|inflation|rate|treasury|фрс|ставка/.test(lower))
    return "MACRO_POLICY";
  if (/earnings|guidance|revenue|capex|nvidia|huang|отчет|прогноз/.test(lower))
    return "EARNINGS_GUIDANCE";
  if (/mint|burn|inflow|outflow|liquidation|tvl|приток|отток/.test(lower))
    return "LIQUIDITY_FLOW";
  return "NARRATIVE";
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
