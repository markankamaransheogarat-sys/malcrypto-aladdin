/**
 * Zero-Key Public Market, On-Chain, Prediction Market & News Feeds
 * Works in modern Browsers (GitHub Pages) and Node 22+ natively without API keys.
 */

export interface LiveTickerQuote {
  symbol: string;
  nodeId: string;
  price: number;
  change24hPct: number;
}

export interface LivePerpMetrics {
  symbol: string;
  nodeId: string;
  markPrice: number;
  fundingRate8h: number;
  openInterestUsd: number;
  spotDepth2PctUsd: number;
}

export interface PolymarketSignal {
  id: string;
  question: string;
  yesProbability: number;
  volume24hUsd: number;
  slug: string;
}

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  seendate: string;
}

const BINANCE_TO_NODE: Record<string, string> = {
  BTCUSDT: "CRYPTO_BTC",
  ETHUSDT: "CRYPTO_ETH",
  SOLUSDT: "CRYPTO_SOL",
  RENDERUSDT: "CRYPTO_RENDER",
  TAOUSDT: "CRYPTO_TAO",
  FETUSDT: "CRYPTO_FET",
  LINKUSDT: "CRYPTO_LINK",
};

export async function fetchBinanceSpotQuotes(): Promise<LiveTickerQuote[]> {
  try {
    const symbols = JSON.stringify(Object.keys(BINANCE_TO_NODE));
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      symbol: string;
      lastPrice: string;
      priceChangePercent: string;
    }>;
    return data
      .filter((d) => BINANCE_TO_NODE[d.symbol])
      .map((d) => ({
        symbol: d.symbol,
        nodeId: BINANCE_TO_NODE[d.symbol],
        price: Number(d.lastPrice),
        change24hPct: Number(d.priceChangePercent),
      }));
  } catch {
    return [];
  }
}

export async function fetchBinanceKlinesReturns(
  symbol: string,
  interval = "15m",
  limit = 96,
): Promise<number[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Array<string | number>>;
    const closes = rows
      .map((r) => Number(r[4]))
      .filter((c) => Number.isFinite(c) && c > 0);
    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
    }
    return returns;
  } catch {
    return [];
  }
}

export async function fetchBinancePerpFragilityInputs(
  symbol = "BTCUSDT",
): Promise<LivePerpMetrics | null> {
  try {
    const [premRes, oiRes, depthRes] = await Promise.all([
      fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`, {
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${symbol}`, {
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=100`, {
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    if (!premRes.ok || !oiRes.ok || !depthRes.ok) return null;
    const prem = (await premRes.json()) as {
      markPrice: string;
      lastFundingRate: string;
    };
    const oi = (await oiRes.json()) as { openInterest: string };
    const depth = (await depthRes.json()) as {
      bids: Array<[string, string]>;
      asks: Array<[string, string]>;
    };

    const markPrice = Number(prem.markPrice);
    const openInterestUsd = Number(oi.openInterest) * markPrice;
    const fundingRate8h = Number(prem.lastFundingRate);

    let spotDepth2PctUsd = 0;
    const lowBound = markPrice * 0.98;
    const highBound = markPrice * 1.02;
    for (const [p, q] of depth.bids) {
      const px = Number(p);
      if (px >= lowBound) spotDepth2PctUsd += px * Number(q);
    }
    for (const [p, q] of depth.asks) {
      const px = Number(p);
      if (px <= highBound) spotDepth2PctUsd += px * Number(q);
    }

    return {
      symbol,
      nodeId: BINANCE_TO_NODE[symbol] ?? "CRYPTO_BTC",
      markPrice,
      fundingRate8h,
      openInterestUsd,
      spotDepth2PctUsd: Math.max(spotDepth2PctUsd, 1_000_000),
    };
  } catch {
    return null;
  }
}

export async function fetchPolymarketTopSignals(): Promise<PolymarketSignal[]> {
  try {
    const url =
      "https://gamma-api.polymarket.com/markets?closed=false&limit=12&order=volume24hr&ascending=false";
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      id: string;
      question: string;
      outcomePrices?: string;
      volume24hr?: number;
      slug?: string;
    }>;

    return data
      .map((m) => {
        let yesProb = 0.5;
        try {
          if (m.outcomePrices) {
            const parsed = JSON.parse(m.outcomePrices) as string[];
            if (parsed.length > 0) yesProb = Number(parsed[0]) || 0.5;
          }
        } catch {
          yesProb = 0.5;
        }
        return {
          id: m.id,
          question: m.question,
          yesProbability: yesProb,
          volume24hUsd: Number(m.volume24hr ?? 0),
          slug: m.slug ?? "",
        };
      })
      .filter((m) => m.question.length > 0);
  } catch {
    return [];
  }
}

export async function fetchGdeltNews(): Promise<GdeltArticle[]> {
  try {
    const query = encodeURIComponent(
      '(bitcoin OR crypto OR nvidia OR "federal reserve" OR sec OR tether) sourcelang:eng',
    );
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${query}&mode=ArtList&maxrecords=20&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return [];
    const json = (await res.json()) as { articles?: GdeltArticle[] };
    return json.articles ?? [];
  } catch {
    return [];
  }
}

export async function fetchDefiLlamaGlobalTvl(): Promise<{
  totalTvlUsd: number;
} | null> {
  try {
    const res = await fetch("https://api.llama.fi/v2/chains", {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const chains = (await res.json()) as Array<{ tvl?: number }>;
    const totalTvlUsd = chains.reduce(
      (acc, c) => acc + (Number(c.tvl) || 0),
      0,
    );
    return { totalTvlUsd };
  } catch {
    return null;
  }
}
