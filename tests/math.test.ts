import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  benjaminiHochbergFDR,
  brierScore,
  detectMarketRegime,
  grangerCausalityTest,
  tailBeta,
} from "../src/core/math.js";

describe("Math & Statistical Engine", () => {
  it("detects Granger causality when X leads Y by 1 step", () => {
    const n = 120;
    const x: number[] = [];
    const y: number[] = [0];

    // Deterministic pseudo-random wave + noise
    for (let i = 0; i < n; i++) {
      x.push(Math.sin(i * 0.37) * 2 + Math.cos(i * 0.91) * 0.8);
    }
    for (let i = 1; i < n; i++) {
      y.push(0.78 * x[i - 1] + 0.15 * Math.sin(i * 1.7));
    }

    const res = grangerCausalityTest(x, y, 1);
    assert.ok(res.fStat > 15, `Expected high F-stat, got ${res.fStat}`);
    assert.ok(res.pValue < 0.01, `Expected p < 0.01, got ${res.pValue}`);
  });

  it("computes elevated downside tailBeta during >1.5 sigma drops", () => {
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < 60; i++) {
      const val = i % 10 === 0 ? -3.5 - (i / 10) * 0.4 : Math.sin(i) * 0.6;
      x.push(val);
      // Y amplifies downside shocks 1.8x
      y.push(val < -2 ? val * 1.8 : val * 0.4);
    }
    const tb = tailBeta(x, y, 1.5);
    assert.ok(tb > 1.4, `Expected tailBeta > 1.4, got ${tb}`);
  });

  it("applies Benjamini-Hochberg FDR correction accurately", () => {
    const pVals = [0.001, 0.008, 0.04, 0.45, 0.82];
    const flags = benjaminiHochbergFDR(pVals, 0.05);
    assert.deepEqual(flags, [true, true, false, false, false]);
  });

  it("computes Brier Score and detects Market Regime", () => {
    const bs = brierScore([
      { prob: 0.8, outcome: 1 },
      { prob: 0.2, outcome: 0 },
    ]);
    assert.ok(Math.abs(bs - 0.04) < 1e-6);
    assert.equal(detectMarketRegime(75, 0.01, -3), "STRESS_CORRELATION_ONE");
    assert.equal(detectMarketRegime(40, 0.04, -1), "EUPHORIA_OVERLEVERAGED");
    assert.equal(detectMarketRegime(35, 0.01, -1), "RISK_ON_CALM");
  });
});
