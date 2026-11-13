/**
 * Real-Time Zero-Key WebSocket Stream Hub
 * Streams live sub-second spot miniTickers and Futures forced liquidations (!forceOrder@arr).
 */

export interface LiquidationEvent {
  timestamp: number;
  symbol: string;
  side: "BUY" | "SELL"; // SELL = Long liquidated, BUY = Short liquidated
  notionalUsd: number;
  price: number;
}

export interface MiniTickerUpdate {
  symbol: string;
  price: number;
  open24h: number;
  change24hPct: number;
}

export interface WsCallbacks {
  onTicker?: (update: MiniTickerUpdate) => void;
  onLiquidation?: (liq: LiquidationEvent) => void;
  onStatus?: (connected: boolean) => void;
}

export class LiveWebSocketHub {
  private tickerWs: WebSocket | null = null;
  private liqWs: WebSocket | null = null;
  private callbacks: WsCallbacks;
  private recentLiqs: LiquidationEvent[] = [];
  private stopped = false;

  constructor(callbacks: WsCallbacks) {
    this.callbacks = callbacks;
  }

  start(): void {
    if (typeof WebSocket === "undefined") return;
    this.stopped = false;
    this.connectTickers();
    this.connectLiquidations();
  }

  stop(): void {
    this.stopped = true;
    this.tickerWs?.close();
    this.liqWs?.close();
    this.tickerWs = null;
    this.liqWs = null;
  }

  getLiquidationStats(windowMs = 5 * 60 * 1000): {
    longLiqUsd: number;
    shortLiqUsd: number;
    totalUsd: number;
    count: number;
    recent: LiquidationEvent[];
  } {
    const cutoff = Date.now() - windowMs;
    this.recentLiqs = this.recentLiqs.filter((l) => l.timestamp >= cutoff);
    let longLiqUsd = 0;
    let shortLiqUsd = 0;
    for (const l of this.recentLiqs) {
      if (l.side === "SELL") longLiqUsd += l.notionalUsd;
      else shortLiqUsd += l.notionalUsd;
    }
    return {
      longLiqUsd,
      shortLiqUsd,
      totalUsd: longLiqUsd + shortLiqUsd,
      count: this.recentLiqs.length,
      recent: this.recentLiqs.slice(-20).reverse(),
    };
  }

  private connectTickers(): void {
    if (this.stopped) return;
    const streams = [
      "btcusdt@miniTicker",
      "ethusdt@miniTicker",
      "solusdt@miniTicker",
      "renderusdt@miniTicker",
      "taousdt@miniTicker",
      "fetusdt@miniTicker",
      "linkusdt@miniTicker",
    ].join("/");

    const ws = new WebSocket(
      `wss://stream.binance.com:9443/stream?streams=${streams}`,
    );
    this.tickerWs = ws;

    ws.onopen = () => this.callbacks.onStatus?.(true);
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          data?: { s: string; c: string; o: string };
        };
        if (!msg.data) return;
        const price = Number(msg.data.c);
        const open = Number(msg.data.o);
        if (!price || !open) return;
        this.callbacks.onTicker?.({
          symbol: msg.data.s,
          price,
          open24h: open,
          change24hPct: ((price - open) / open) * 100,
        });
      } catch {
        // ignore malformed frame
      }
    };
    ws.onclose = () => {
      this.callbacks.onStatus?.(false);
      if (!this.stopped) setTimeout(() => this.connectTickers(), 4000);
    };
    ws.onerror = () => ws.close();
  }

  private connectLiquidations(): void {
    if (this.stopped) return;
    const ws = new WebSocket("wss://fstream.binance.com/ws/!forceOrder@arr");
    this.liqWs = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          o?: {
            s: string;
            S: "BUY" | "SELL";
            q: string;
            ap: string;
            T: number;
          };
        };
        if (!msg.o) return;
        const price = Number(msg.o.ap);
        const qty = Number(msg.o.q);
        const notionalUsd = price * qty;
        if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) return;

        const liq: LiquidationEvent = {
          timestamp: msg.o.T || Date.now(),
          symbol: msg.o.s,
          side: msg.o.S,
          notionalUsd,
          price,
        };
        this.recentLiqs.push(liq);
        if (this.recentLiqs.length > 500) this.recentLiqs.shift();
        this.callbacks.onLiquidation?.(liq);
      } catch {
        // ignore
      }
    };
    ws.onclose = () => {
      if (!this.stopped) setTimeout(() => this.connectLiquidations(), 4000);
    };
    ws.onerror = () => ws.close();
  }
}
