/**
 * Market Fragility & "Tinderbox" Detector (Pre-Mortem Engine)
 * Measures leverage saturation, orderbook thinness, and liquidation cluster proximity
 * BEFORE news hits, identifying where small sparks trigger outsized cascades.
 */

import { clamp } from "../core/math.js";
import type { FragilityMetrics } from "../core/types.js";

export interface FragilityInput {
  nodeId: string;
  openInterestUsd: number;
  /** Combined Bid+Ask liquidity within ±2% of mid-price */
  spotDepth2PctUsd: number;
  /** 8-hour perpetual funding rate (e.g. 0.0001 = 0.01%, 0.0005 = 0.05%) */
  fundingRate8h: number;
  /** Long/Short account ratio (> 1 means crowded longs) */
  longShortRatio: number;
  /** Distance in % to nearest major liquidation cluster (e.g. 2.5 means 2.5% away) */
  nearestLiqClusterPct: number;
}

export function computeFragilityMetrics(
  input: FragilityInput,
): FragilityMetrics {
  const depth = Math.max(input.spotDepth2PctUsd, 1_000_000);
  const oiToDepthRatio = input.openInterestUsd / depth;

  // Component 1: Leverage vs Orderbook Depth (0..35 pts)
  // Ratio > 120 indicates severe leverage relative to resting liquidity
  const depthComponent = clamp((oiToDepthRatio / 120) * 35, 0, 35);

  // Component 2: Funding Crowding (0..25 pts)
  // |funding| >= 0.05% per 8h (~55% APR) is extreme crowding
  const absFundingPct = Math.abs(input.fundingRate8h) * 100;
  const fundingComponent = clamp((absFundingPct / 0.05) * 25, 0, 25);

  // Component 3: Long/Short Skew (0..20 pts)
  const skewExcess = Math.abs(input.longShortRatio - 1.0);
  const skewComponent = clamp((skewExcess / 1.2) * 20, 0, 20);

  // Component 4: Proximity to Liquidation Magnet (0..20 pts)
  // Closer than 1.5% -> maximum danger
  const dist = Math.max(0.2, input.nearestLiqClusterPct);
  const liqComponent = clamp((1 - (dist - 0.5) / 5.5) * 20, 0, 20);

  const fragilityScore = Math.round(
    clamp(
      depthComponent + fundingComponent + skewComponent + liqComponent,
      0,
      100,
    ),
  );

  let status: FragilityMetrics["status"] = "RESILIENT";
  if (fragilityScore >= 68) status = "TINDERBOX";
  else if (fragilityScore >= 42) status = "ELEVATED";

  return {
    nodeId: input.nodeId,
    openInterestUsd: input.openInterestUsd,
    spotDepth2PctUsd: input.spotDepth2PctUsd,
    oiToDepthRatio: Number(oiToDepthRatio.toFixed(1)),
    fundingRate8h: input.fundingRate8h,
    longShortRatio: input.longShortRatio,
    nearestLiqClusterPct: input.nearestLiqClusterPct,
    fragilityScore,
    status,
  };
}
