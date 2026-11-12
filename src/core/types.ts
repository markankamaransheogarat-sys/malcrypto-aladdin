/**
 * Core Domain Types for MalCrypto Aladdin
 * Cross-Market Bi-Temporal Knowledge Graph & Causal Risk Engine
 */

export type NodeTier =
  | "ACTOR" // Tier 0: Key persons, funds, regulators, market makers (e.g. Jensen Huang, Powell, SEC, Wintermute)
  | "MACRO_EQUITY" // Tier 1: Equities, indices, rates, FX (e.g. NVDA, QQQ, DXY, US10Y, VIX, MSTR)
  | "INFRA_STABLE" // Tier 2: Exchanges, stablecoins, DeFi protocols (e.g. USDT, USDC, Binance, Aave)
  | "CRYPTO_ASSET" // Tier 3: Crypto majors & sector tokens (e.g. BTC, ETH, SOL, RENDER, TAO, FET)
  | "NARRATIVE"; // Tier 4: Thematic clusters (e.g. AI Compute, Spot ETF, DeFi Yield, Memes)

export type RelationType =
  | "KEY_PERSON"
  | "SUPPLY_CHAIN"
  | "REGULATES"
  | "CUSTODY_RESERVE"
  | "MARKET_MAKER"
  | "MACRO_BETA"
  | "NARRATIVE_PROXY"
  | "LIQUIDITY_BACKBONE"
  | "COLLATERAL_LINK"
  | "CAUSAL_LAG";

export type MarketRegime =
  "RISK_ON_CALM" | "EUPHORIA_OVERLEVERAGED" | "STRESS_CORRELATION_ONE";

export interface GraphNode {
  id: string;
  label: string;
  ticker?: string;
  tier: NodeTier;
  sector: string;
  /** Aliases for zero-shot entity linking from news */
  aliases: string[];
  /** Baseline systemic importance [0..1] */
  systemicWeight: number;
  /** Live price or index value if tradable */
  price?: number;
  /** 24h % change */
  change24hPct?: number;
  /** Current fragility [0..100] */
  fragilityScore?: number;
  /** Optional description for Maltego inspector */
  description?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relation: RelationType;
  /** Normal-regime transmission weight [0..1] */
  weight: number;
  /** Stress/panic-regime transmission weight [0..1.5] (captures correlation->1 in crises) */
  stressWeight: number;
  /** Typical propagation lag in minutes */
  lagMinutes: number;
  /** Sign of impact: +1 (same direction) or -1 (inverse, e.g. DXY -> BTC) */
  polarity: 1 | -1;
  /** Statistical confidence [0..1] */
  confidence: number;
  /** Source of edge discovery */
  origin: "SKELETON" | "CAUSAL_ENGINE" | "NEWS_HYPOTHESIS";
  /** Bi-temporal validity: epoch ms when relationship became active */
  validFrom: number;
  /** Bi-temporal validity: null if still active, or epoch ms when superseded/pruned */
  validTo: number | null;
  /** Evidence notes */
  evidence?: string;
}

export interface CausalDiscoveryResult {
  source: string;
  target: string;
  optimalLagSteps: number;
  lagMinutes: number;
  correlation: number;
  grangerFStat: number;
  pValue: number;
  fdrSignificant: boolean;
  tailBetaDownside: number;
  polarity: 1 | -1;
  sampleSize: number;
}

export interface NewsEvent {
  id: string;
  timestamp: number;
  title: string;
  source: string;
  url?: string;
  /** Source credibility [0..1] */
  trustScore: number;
  /** Matched node IDs from Knowledge Graph */
  matchedNodes: string[];
  /** Raw sentiment [-1..+1] */
  sentiment: number;
  /** Surprise relative to market expectations [-1..+1] */
  surpriseScore: number;
  /** Event category */
  category:
    | "EARNINGS_GUIDANCE"
    | "MACRO_POLICY"
    | "REGULATION"
    | "HACK_EXPLOIT"
    | "LIQUIDITY_FLOW"
    | "NARRATIVE";
  /** Verification status */
  status: "VERIFIED" | "CORROBORATED" | "RUMOUR";
}

export interface FragilityMetrics {
  nodeId: string;
  openInterestUsd: number;
  spotDepth2PctUsd: number;
  oiToDepthRatio: number;
  fundingRate8h: number;
  longShortRatio: number;
  nearestLiqClusterPct: number;
  /** Composite fragility score [0..100] */
  fragilityScore: number;
  status: "RESILIENT" | "ELEVATED" | "TINDERBOX";
}

export interface ShockInput {
  triggerNodeId: string;
  /** Magnitude of shock in % (e.g. -8 for -8% NVDA drop, or negative sentiment shock) */
  shockPct: number;
  /** Optional surprise multiplier [0.5..2.0] */
  surpriseMultiplier?: number;
  /** Timestamp for bi-temporal graph lookup (defaults to Date.now()) */
  asOfTimestamp?: number;
  /** Regime override or auto-detected */
  regime?: MarketRegime;
}

export interface ContagionNodeResult {
  nodeId: string;
  label: string;
  tier: NodeTier;
  hop: number;
  etaMinutes: number;
  expectedMovePct: number;
  p10MovePct: number;
  p50MovePct: number;
  p90MovePct: number;
  path: string[];
  fragilityAmplifier: number;
}

export interface ScenarioBranch {
  name: "CASCADE_CRASH" | "BASE_REPRICING" | "ABSORPTION_REVERSAL";
  label: string;
  probability: number;
  horizonHours: number;
  btcExpectedPct: number;
  triggerCondition: string;
}

export interface SimulationResult {
  id: string;
  timestamp: number;
  triggerNodeId: string;
  triggerLabel: string;
  shockPct: number;
  regime: MarketRegime;
  affectedNodes: ContagionNodeResult[];
  scenarios: ScenarioBranch[];
  maxCascadeDepth: number;
  totalSystemicRiskScore: number;
}

export interface PredictionRecord {
  id: string;
  createdAt: number;
  targetNodeId: string;
  triggerNodeId: string;
  predictedCrashProb: number;
  predictedMovePct: number;
  horizonHours: number;
  thresholdPct: number;
  resolvedAt?: number;
  actualMovePct?: number;
  outcomeOccurred?: 0 | 1;
  brierContribution?: number;
}

export interface CalibrationReport {
  totalPredictions: number;
  resolvedCount: number;
  brierScore: number;
  hitRate: number;
  avgPredictedProb: number;
}
