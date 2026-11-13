/**
 * Global Cross-Market Events Database (data/events_db.json)
 * Deduplicates and persists real news, SEC filings, Fed releases, options expiries,
 * and on-chain/derivative shocks with matched Knowledge Graph nodes & impact tags.
 */

export interface StoredMarketEvent {
  id: string;
  timestamp: number;
  title: string;
  source: string;
  category:
    "CRYPTO" | "MACRO" | "REGULATORY" | "ONCHAIN" | "DERIVATIVES" | "INSIDER";
  url?: string;
  matchedNodes: string[];
  surpriseScore: number;
  impact: "CRITICAL" | "HIGH" | "MEDIUM";
}

export class EventDatabaseStore {
  private events = new Map<string, StoredMarketEvent>();
  private readonly maxEvents = 1000;

  load(saved: StoredMarketEvent[]): void {
    for (const ev of saved) {
      if (ev && ev.id && ev.title) {
        this.events.set(ev.id, ev);
      }
    }
    this.trim();
  }

  upsertMany(items: StoredMarketEvent[]): number {
    let added = 0;
    const normalizedTitles = new Set(
      [...this.events.values()].map((e) => e.title.toLowerCase().slice(0, 64)),
    );
    for (const item of items) {
      const keyTitle = item.title.toLowerCase().slice(0, 64);
      if (this.events.has(item.id) || normalizedTitles.has(keyTitle)) continue;
      this.events.set(item.id, item);
      normalizedTitles.add(keyTitle);
      added++;
    }
    this.trim();
    return added;
  }

  getAll(): StoredMarketEvent[] {
    return [...this.events.values()].sort((a, b) => b.timestamp - a.timestamp);
  }

  query(opts?: {
    category?: string;
    search?: string;
    limit?: number;
  }): StoredMarketEvent[] {
    const q = (opts?.search ?? "").trim().toLowerCase();
    const cat = opts?.category ?? "ALL";
    const limit = opts?.limit ?? 150;
    return this.getAll()
      .filter((ev) => {
        if (cat !== "ALL" && ev.category !== cat) return false;
        if (
          q &&
          !ev.title.toLowerCase().includes(q) &&
          !ev.source.toLowerCase().includes(q) &&
          !ev.matchedNodes.some((n) => n.toLowerCase().includes(q))
        ) {
          return false;
        }
        return true;
      })
      .slice(0, limit);
  }

  private trim(): void {
    if (this.events.size <= this.maxEvents) return;
    const sorted = this.getAll().slice(0, this.maxEvents);
    this.events.clear();
    for (const ev of sorted) this.events.set(ev.id, ev);
  }
}
