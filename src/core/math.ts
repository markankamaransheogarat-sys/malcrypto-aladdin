/**
 * Quantitative & Statistical Math Engine
 * Zero external dependencies — deterministic, unit-tested numerical routines.
 */

import type { MarketRegime } from "./types.js";

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function mean(arr: readonly number[]): number {
  if (arr.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i];
  return sum / arr.length;
}

export function stdDev(arr: readonly number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let sq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i] - m;
    sq += d * d;
  }
  return Math.sqrt(sq / (arr.length - 1));
}

export function quantile(sortedOrRaw: readonly number[], q: number): number {
  if (sortedOrRaw.length === 0) return 0;
  const arr = [...sortedOrRaw].sort((a, b) => a - b);
  const pos = clamp(q, 0, 1) * (arr.length - 1);
  const base = Math.floor(pos);
  const rest = pos - base;
  if (arr[base + 1] !== undefined) {
    return arr[base] + rest * (arr[base + 1] - arr[base]);
  }
  return arr[base];
}

export function pearsonCorrelation(
  x: readonly number[],
  y: readonly number[],
): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;
  let sx = 0,
    sy = 0,
    sxx = 0,
    syy = 0,
    sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
    sxx += x[i] * x[i];
    syy += y[i] * y[i];
    sxy += x[i] * y[i];
  }
  const num = n * sxy - sx * sy;
  const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  if (den <= 1e-12) return 0;
  return clamp(num / den, -1, 1);
}

/**
 * Computes lagged cross-correlation where X leads Y by `lag` steps: corr(X[t - lag], Y[t]).
 */
export function laggedCorrelation(
  x: readonly number[],
  y: readonly number[],
  lag: number,
): number {
  const n = Math.min(x.length, y.length);
  if (lag < 0 || n - lag < 5) return 0;
  const xSlice = x.slice(0, n - lag);
  const ySlice = y.slice(lag, n);
  return pearsonCorrelation(xSlice, ySlice);
}

/**
 * Tail Beta: measures how strongly Y moves when X experiences a downside shock (< -sigmaThreshold * std(X)).
 * Captures crisis "correlation -> 1" behavior that standard Pearson misses.
 */
export function tailBeta(
  xReturns: readonly number[],
  yReturns: readonly number[],
  sigmaThreshold = 1.5,
): number {
  const n = Math.min(xReturns.length, yReturns.length);
  if (n < 10) return 1.0;

  const xSub = xReturns.slice(0, n);
  const ySub = yReturns.slice(0, n);
  const mx = mean(xSub);
  const sx = stdDev(xSub);
  if (sx <= 1e-12) return 1.0;

  const cutoff = mx - sigmaThreshold * sx;
  const tailX: number[] = [];
  const tailY: number[] = [];

  for (let i = 0; i < n; i++) {
    if (xSub[i] <= cutoff) {
      tailX.push(xSub[i]);
      tailY.push(ySub[i]);
    }
  }

  if (tailX.length < 3) {
    // Fallback to overall OLS beta if too few extreme tail points
    const corr = pearsonCorrelation(xSub, ySub);
    const sy = stdDev(ySub);
    return sx > 1e-12 ? corr * (sy / sx) : 1.0;
  }

  // OLS beta on tail observations: cov(X,Y)/var(X)
  const mtx = mean(tailX);
  const mty = mean(tailY);
  let num = 0;
  let den = 0;
  for (let i = 0; i < tailX.length; i++) {
    const dx = tailX[i] - mtx;
    num += dx * (tailY[i] - mty);
    den += dx * dx;
  }
  if (den <= 1e-12) {
    return Math.abs(mtx) > 1e-9 ? clamp(mty / mtx, -5, 5) : 1.0;
  }
  return clamp(num / den, -5, 5);
}

/**
 * Approximate p-value from F-statistic using Wilson-Hilferty normal approximation to chi-square/F.
 * Accurate enough for online FDR filtering without heavy special-function dependencies.
 */
export function approximateFTestPValue(
  fStat: number,
  df1: number,
  df2: number,
): number {
  if (fStat <= 0 || df1 <= 0 || df2 <= 0) return 1;
  // Convert F(df1, df2) to z-score via Paulson / Wilson-Hilferty approximation
  const a = 2 / (9 * df1);
  const b = 2 / (9 * df2);
  const num = (1 - b) * Math.pow(fStat, 1 / 3) - (1 - a);
  const den = Math.sqrt(b * Math.pow(fStat, 2 / 3) + a);
  if (den <= 1e-12) return 1;
  const z = num / den;
  // Standard normal survival function 1 - Phi(z)
  return normalSurvival(z);
}

function normalSurvival(z: number): number {
  if (z < -8) return 1;
  if (z > 8) return 0;
  // Abramowitz & Stegun 7.1.26 erf approximation
  const absZ = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * absZ);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-absZ * absZ);
  const cdf = z >= 0 ? 1 - 0.5 * erfc : 0.5 * erfc;
  return clamp(1 - cdf, 0, 1);
}

/**
 * Solves small linear system A * x = b using Gaussian elimination with partial pivoting.
 */
function solveLinearSystem(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);

  for (let col = 0; col < n; col++) {
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[maxRow][col])) maxRow = row;
    }
    [M[col], M[maxRow]] = [M[maxRow], M[col]];
    const pivot = M[col][col];
    if (Math.abs(pivot) < 1e-12) continue;

    for (let row = col + 1; row < n; row++) {
      const factor = M[row][col] / pivot;
      for (let k = col; k <= n; k++) {
        M[row][k] -= factor * M[col][k];
      }
    }
  }

  const x = new Array(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = M[i][n];
    for (let j = i + 1; j < n; j++) sum -= M[i][j] * x[j];
    x[i] = Math.abs(M[i][i]) > 1e-12 ? sum / M[i][i] : 0;
  }
  return x;
}

function olsResidualSumOfSquares(X: number[][], y: number[]): number {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n <= p || p === 0) return Infinity;

  // Normal equations: (X^T X + ridge) beta = X^T y
  const XtX: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty: number[] = new Array(p).fill(0);

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < p; k++) {
        XtX[j][k] += X[i][j] * X[i][k];
      }
    }
  }
  // Tiny ridge for numerical stability
  for (let j = 0; j < p; j++) XtX[j][j] += 1e-8;

  const beta = solveLinearSystem(XtX, Xty);
  let rss = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < p; j++) pred += X[i][j] * beta[j];
    const err = y[i] - pred;
    rss += err * err;
  }
  return rss;
}

/**
 * Bivariate Granger Causality Test: X -> Y at lag `lag`.
 * Compares restricted AR(lag) of Y vs unrestricted AR(lag) of Y + lagged X.
 */
export function grangerCausalityTest(
  x: readonly number[],
  y: readonly number[],
  lag: number,
): { fStat: number; pValue: number } {
  const n = Math.min(x.length, y.length);
  if (lag < 1 || n - lag < 2 * lag + 6) {
    return { fStat: 0, pValue: 1 };
  }

  const yTarget: number[] = [];
  const xRestricted: number[][] = [];
  const xUnrestricted: number[][] = [];

  for (let t = lag; t < n; t++) {
    yTarget.push(y[t]);
    const rowR: number[] = [1]; // intercept
    const rowU: number[] = [1];
    for (let l = 1; l <= lag; l++) {
      rowR.push(y[t - l]);
      rowU.push(y[t - l]);
    }
    for (let l = 1; l <= lag; l++) {
      rowU.push(x[t - l]);
    }
    xRestricted.push(rowR);
    xUnrestricted.push(rowU);
  }

  const rssR = olsResidualSumOfSquares(xRestricted, yTarget);
  const rssU = olsResidualSumOfSquares(xUnrestricted, yTarget);
  const df1 = lag;
  const df2 = yTarget.length - (1 + 2 * lag);

  if (rssU <= 1e-12 || df2 <= 0 || rssR <= rssU) {
    return { fStat: 0, pValue: 1 };
  }

  const fStat = (rssR - rssU) / df1 / (rssU / df2);
  const pValue = approximateFTestPValue(fStat, df1, df2);
  return { fStat, pValue };
}

/**
 * Benjamini-Hochberg False Discovery Rate (FDR) correction.
 * Returns boolean array indicating which hypotheses remain statistically significant.
 */
export function benjaminiHochbergFDR(
  pValues: readonly number[],
  alpha = 0.05,
): boolean[] {
  const m = pValues.length;
  if (m === 0) return [];

  const indexed = pValues
    .map((p, idx) => ({ p, idx }))
    .sort((a, b) => a.p - b.p);
  let maxPassingRank = -1;

  for (let i = 0; i < m; i++) {
    const rank = i + 1;
    const threshold = (rank / m) * alpha;
    if (indexed[i].p <= threshold) {
      maxPassingRank = i;
    }
  }

  const significant = new Array<boolean>(m).fill(false);
  if (maxPassingRank >= 0) {
    for (let i = 0; i <= maxPassingRank; i++) {
      significant[indexed[i].idx] = true;
    }
  }
  return significant;
}

/**
 * 3-State Market Regime Classifier (HMM-inspired volatility + funding + drawdown state).
 */
export function detectMarketRegime(
  realizedVolAnnualizedPct: number,
  avgFunding8hPct: number,
  btcDrawdownFromPeakPct: number,
): MarketRegime {
  if (realizedVolAnnualizedPct >= 70 || btcDrawdownFromPeakPct <= -8) {
    return "STRESS_CORRELATION_ONE";
  }
  if (avgFunding8hPct >= 0.03) {
    return "EUPHORIA_OVERLEVERAGED";
  }
  return "RISK_ON_CALM";
}

/**
 * Brier Score for probability calibration: mean((p_i - o_i)^2).
 * 0.0 = perfect calibration, 0.25 = random 50/50 coin flip.
 */
export function brierScore(
  predictions: readonly { prob: number; outcome: 0 | 1 }[],
): number {
  if (predictions.length === 0) return 0;
  let sum = 0;
  for (const item of predictions) {
    const d = clamp(item.prob, 0, 1) - item.outcome;
    sum += d * d;
  }
  return sum / predictions.length;
}

/**
 * Annualized Sharpe Ratio from periodic return fractions (e.g., 0.01 = +1%).
 */
export function sharpeRatio(
  returns: readonly number[],
  riskFreePerPeriod = 0,
  periodsPerYear = 252,
): number {
  if (returns.length < 2) return 0;
  const excess = returns.map((r) => r - riskFreePerPeriod);
  const sd = stdDev(excess);
  if (sd <= 1e-12) return 0;
  return (mean(excess) / sd) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sortino Ratio using downside deviation below `targetPerPeriod`.
 */
export function sortinoRatio(
  returns: readonly number[],
  targetPerPeriod = 0,
  periodsPerYear = 252,
): number {
  if (returns.length < 2) return 0;
  const excessMean = mean(returns.map((r) => r - targetPerPeriod));
  const downsideSq =
    returns.reduce((acc, r) => {
      const diff = Math.min(0, r - targetPerPeriod);
      return acc + diff * diff;
    }, 0) / returns.length;
  const downsideDev = Math.sqrt(downsideSq);
  if (downsideDev <= 1e-12) return 0;
  return (excessMean / downsideDev) * Math.sqrt(periodsPerYear);
}
