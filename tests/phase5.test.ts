import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BriefVerdictTracker,
  ExecutiveBriefingEngine,
  type ExecutiveBriefing,
} from "../src/aladdin/briefing.js";
import { MacroCalendarEngine } from "../src/aladdin/macro-calendar.js";

describe("Phase 5: Macro Calendar & Brief Verdict Win-Rate Tracker", () => {
  it("computes upcoming Deribit last-Friday options expiry and imminent FOMC DVOL boost", () => {
    const cal = new MacroCalendarEngine();
    // Nov 20, 2026 -> Nov 27, 2026 is the last Friday of Nov 2026 (08:00 UTC)
    const nov20 = Date.UTC(2026, 10, 20, 12, 0);
    const events = cal.getUpcomingEvents(nov20, 10);
    assert.ok(events.some((e) => e.category === "OPTIONS_EXPIRY"));
    const exp = events.find((e) => e.category === "OPTIONS_EXPIRY")!;
    assert.equal(new Date(exp.timestamp).getUTCDay(), 5);
    assert.equal(new Date(exp.timestamp).getUTCHours(), 8);

    // 24h before FOMC Dec 9, 2026 19:00 UTC -> +18% DVOL boost
    const dec8 = Date.UTC(2026, 11, 8, 19, 0);
    const boost = cal.getImminentDvolBoostPct(dec8);
    assert.equal(boost.boostPct, 18);
    assert.equal(boost.imminentEvent?.category, "FOMC");
  });

  it("injects Macro Event Calendar driver and widens horizon bands when event <=48h", () => {
    const engine = new ExecutiveBriefingEngine();
    const baseInput = {
      btcPrice: 70_000,
      btcChange24hPct: 1.5,
      dvolPct: 40,
      stablePegs: [
        { symbol: "USDT", price: 1.0, pegDeviationBps: 0, timestamp: 1 },
      ],
      liq5mLongUsd: 100_000,
      liq5mShortUsd: 250_000,
      regime: "RISK_ON_TRENDING" as const,
      newsFeed: [],
    };

    const quietTime = Date.UTC(2026, 10, 15, 12, 0);
    const imminentFomc = Date.UTC(2026, 11, 8, 19, 0);

    const quietBrief = engine.generate({ ...baseInput, now: quietTime });
    const fomcBrief = engine.generate({ ...baseInput, now: imminentFomc });

    assert.ok(
      fomcBrief.drivers.some((d) => d.factor === "Macro Event Calendar"),
    );
    assert.ok(fomcBrief.upcomingMacroEvents.length > 0);

    const quietSpread =
      quietBrief.horizons[0].p90Price - quietBrief.horizons[0].p10Price;
    const fomcSpread =
      fomcBrief.horizons[0].p90Price - fomcBrief.horizons[0].p10Price;
    assert.ok(fomcSpread > quietSpread);
  });

  it("tracks LONG/SHORT verdicts with 4h throttling and auto-resolves TP/SL/24h", () => {
    const tracker = new BriefVerdictTracker();
    const t0 = Date.UTC(2026, 10, 13, 10, 0);

    const makeBrief = (
      verdict: ExecutiveBriefing["verdict"],
      entry: number,
      sl: number,
      tp: number,
    ): ExecutiveBriefing => ({
      verdict,
      confidencePct: 70,
      compositeScore: verdict === "LONG" ? 30 : verdict === "SHORT" ? -30 : 5,
      btcPrice: entry,
      entryPrice: entry,
      stopLossPrice: sl,
      takeProfitPrice: tp,
      riskRewardRatio: 2.2,
      headlineSummary: "test",
      drivers: [],
      horizons: [],
      topNewsCatalysts: [],
      upcomingMacroEvents: [],
    });

    // WAIT is ignored
    assert.equal(
      tracker.recordVerdict(makeBrief("WAIT", 70_000, 68_000, 74_000), t0),
      null,
    );

    // LONG recorded, duplicate within 4h throttled
    const r1 = tracker.recordVerdict(
      makeBrief("LONG", 70_000, 68_500, 73_300),
      t0,
    );
    assert.ok(r1);
    assert.equal(
      tracker.recordVerdict(
        makeBrief("LONG", 70_200, 68_700, 73_500),
        t0 + 2 * 3600 * 1000,
      ),
      null,
    );

    // Opposite SHORT within 4h is allowed
    const r2 = tracker.recordVerdict(
      makeBrief("SHORT", 70_000, 71_500, 66_700),
      t0 + 2 * 3600 * 1000,
    );
    assert.ok(r2);

    // Resolve r1 via TP hit and r2 via SL hit at 73_500
    const changed = tracker.resolveDueVerdicts(73_500, t0 + 5 * 3600 * 1000);
    assert.equal(changed, true);

    const stats = tracker.getStats();
    assert.equal(stats.total, 2);
    assert.equal(stats.resolved, 2);
    assert.equal(stats.wins, 1);
    assert.equal(stats.winRate, 0.5);
    assert.equal(stats.avgReturnPct, 0);
  });
});
