/**
 * Macro & Derivatives Event Calendar Engine (Phase 5)
 * Tracks FOMC Rate Decisions, US CPI releases, and Deribit Monthly/Quarterly Options Expiries
 * (Last Friday of every month at 08:00 UTC) to adjust DVOL & risk warnings ahead of time.
 */

export interface MacroCalendarEvent {
  id: string;
  title: string;
  category: "FOMC" | "CPI" | "OPTIONS_EXPIRY";
  timestamp: number;
  hoursUntil: number;
  impact: "CRITICAL" | "HIGH";
  dvolBoostPct: number;
}

// Verified FOMC decision timestamps (19:00 UTC) & US CPI release windows (13:30 UTC)
const SCHEDULED_MACRO_EVENTS: Array<{
  id: string;
  title: string;
  category: "FOMC" | "CPI";
  timestamp: number;
  impact: "CRITICAL" | "HIGH";
  dvolBoostPct: number;
}> = [
  {
    id: "fomc_2026_12",
    title: "FOMC Rate Decision & Powell Press Conf",
    category: "FOMC",
    timestamp: Date.UTC(2026, 11, 9, 19, 0),
    impact: "CRITICAL",
    dvolBoostPct: 18,
  },
  {
    id: "cpi_2026_12",
    title: "US CPI Inflation Release",
    category: "CPI",
    timestamp: Date.UTC(2026, 11, 10, 13, 30),
    impact: "CRITICAL",
    dvolBoostPct: 15,
  },
  {
    id: "cpi_2027_01",
    title: "US CPI Inflation Release",
    category: "CPI",
    timestamp: Date.UTC(2027, 0, 13, 13, 30),
    impact: "CRITICAL",
    dvolBoostPct: 15,
  },
  {
    id: "fomc_2027_01",
    title: "FOMC Rate Decision",
    category: "FOMC",
    timestamp: Date.UTC(2027, 0, 27, 19, 0),
    impact: "CRITICAL",
    dvolBoostPct: 18,
  },
  {
    id: "cpi_2027_02",
    title: "US CPI Inflation Release",
    category: "CPI",
    timestamp: Date.UTC(2027, 1, 10, 13, 30),
    impact: "CRITICAL",
    dvolBoostPct: 15,
  },
  {
    id: "fomc_2027_03",
    title: "FOMC Rate Decision & Dot Plot",
    category: "FOMC",
    timestamp: Date.UTC(2027, 2, 17, 18, 0),
    impact: "CRITICAL",
    dvolBoostPct: 20,
  },
];

/**
 * Computes the last Friday of a given UTC month/year at 08:00 UTC (Deribit Options Expiry).
 */
export function getLastFridayUtc(year: number, monthIndex0: number): number {
  const lastDay = new Date(Date.UTC(year, monthIndex0 + 1, 0, 8, 0, 0));
  const dayOfWeek = lastDay.getUTCDay(); // 5 = Friday
  const diff = (dayOfWeek - 5 + 7) % 7;
  lastDay.setUTCDate(lastDay.getUTCDate() - diff);
  return lastDay.getTime();
}

export class MacroCalendarEngine {
  getUpcomingEvents(now = Date.now(), horizonDays = 30): MacroCalendarEvent[] {
    const horizonMs = horizonDays * 86400_000;
    const events: MacroCalendarEvent[] = [];

    for (const ev of SCHEDULED_MACRO_EVENTS) {
      if (ev.timestamp >= now && ev.timestamp <= now + horizonMs) {
        events.push({
          ...ev,
          hoursUntil: Number(((ev.timestamp - now) / 3600_000).toFixed(1)),
        });
      }
    }

    // Add Deribit Monthly & Quarterly Expiries for current + next 2 months
    const baseDate = new Date(now);
    for (let offset = 0; offset <= 2; offset++) {
      const y = baseDate.getUTCFullYear();
      const m = baseDate.getUTCMonth() + offset;
      const dt = new Date(Date.UTC(y, m, 1));
      const expiryTs = getLastFridayUtc(dt.getUTCFullYear(), dt.getUTCMonth());
      if (expiryTs >= now && expiryTs <= now + horizonMs) {
        const isQuarterly = [2, 5, 8, 11].includes(dt.getUTCMonth());
        events.push({
          id: `deribit_exp_${dt.getUTCFullYear()}_${dt.getUTCMonth() + 1}`,
          title: isQuarterly
            ? "Deribit Quarterly BTC/ETH Options Expiry"
            : "Deribit Monthly BTC/ETH Options Expiry",
          category: "OPTIONS_EXPIRY",
          timestamp: expiryTs,
          hoursUntil: Number(((expiryTs - now) / 3600_000).toFixed(1)),
          impact: isQuarterly ? "CRITICAL" : "HIGH",
          dvolBoostPct: isQuarterly ? 14 : 8,
        });
      }
    }

    return events.sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Returns DVOL multiplier if a major macro/expiry event is within 48 hours.
   */
  getImminentDvolBoostPct(now = Date.now()): {
    boostPct: number;
    imminentEvent?: MacroCalendarEvent;
  } {
    const upcoming = this.getUpcomingEvents(now, 3);
    const imminent = upcoming.find((e) => e.hoursUntil <= 48);
    if (!imminent) return { boostPct: 0 };
    return { boostPct: imminent.dvolBoostPct, imminentEvent: imminent };
  }
}
