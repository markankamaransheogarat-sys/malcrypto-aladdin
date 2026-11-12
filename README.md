# 🕸️ MalCrypto × Aladdin — Cross-Market Causal Risk Terminal

Institutional **Bi-Temporal Knowledge Graph (Maltego-style)** + **BlackRock Aladdin Contagion & Scenario Engine** for cross-market risk intelligence (Macro, Equities, Stablecoins, Exchanges, and Crypto).

[![Live Terminal](https://img.shields.io/badge/Live_Terminal-GitHub_Pages-8caa6b?style=for-the-badge&logo=github)](https://markankamaransheogarat-sys.github.io/malcrypto-aladdin/)
[![Tests](https://img.shields.io/badge/Tests-12%2F12_Passed-8caa6b?style=for-the-badge)](https://github.com/markankamaransheogarat-sys/malcrypto-aladdin)
[![Zero-Key Feeds](https://img.shields.io/badge/Feeds-Binance_%2B_Polymarket_%2B_GDELT_%2B_DeFiLlama-5d909b?style=for-the-badge)](https://github.com/markankamaransheogarat-sys/malcrypto-aladdin)

👉 **Launch Live Web Terminal**: [https://markankamaransheogarat-sys.github.io/malcrypto-aladdin/](https://markankamaransheogarat-sys.github.io/malcrypto-aladdin/)

---

## ⚡ 6 Core `<GO>` Modules

| Command | Module & Capabilities |
| :--- | :--- |
| **`🕸️ GRAPH <GO>`** `[F1]` | **60 FPS Interactive Maltego Canvas**: Multi-tier cross-market knowledge graph (`ACTOR` → `MACRO_EQUITY` → `INFRA_STABLE` → `CRYPTO_ASSET` → `NARRATIVE`) with animated shockwave contagion paths and node dependency inspector. |
| **`🎯 RADAR <GO>`** `[F2]` | **Aladdin Pre-Mortem & Scenario Tree**: Live Market Fragility ("Tinderbox") Radar (`OI / ±2% Depth`, Funding crowding, Liquidation cluster proximity) + probability-weighted Scenario Trees (`BASE_REPRICING`, `CASCADE_CRASH`, `ABSORPTION_REVERSAL`). |
| **`🔬 CAUSAL <GO>`** `[F3]` | **Online Lead-Lag & Granger Discovery**: Automated bivariate Granger causality + downside Tail-Beta (`>1.5σ`) + Benjamini-Hochberg FDR pruning on live 15m Binance klines. |
| **`📰 WIRE <GO>`** `[F4]` | **News-to-Graph & Surprise Engine**: GDELT 2.0 + Polymarket + custom headline analyzer with Entity Resolution, Source Trust scoring, and `Surprise = Actual − Expected` filtering. |
| **`⚡ CASCADE <GO>`** `[F5]` | **Interactive Stress-Test Simulator**: Simulate any trigger (e.g. `Jensen Huang / NVDA -9.5%`, `Fed`, `SEC`, `USDT depeg`) across regimes (`STRESS_CORRELATION_ONE`, `EUPHORIA_OVERLEVERAGED`, `RISK_ON_CALM`) with `P10 / P50 / P90` quantiles + Telegram Webhook Bridge. |
| **`📊 CALIB <GO>`** `[F6]` | **Bi-Temporal Audit & Brier Calibration**: Tracks prediction accuracy via Brier Score, prunes weak news hypotheses, and exports/imports full graph snapshots. |

---

## 🚀 Quickstart

```bash
# Run all unit tests
npm test

# Build TypeScript + browser bundle (dist/web.js)
npm run build

# Run live CLI contagion & causal discovery demo
npm run terminal
```
