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

export interface StablecoinPegQuote {
  symbol: string;
  nodeId: string;
  price: number;
  pegDeviationBps: number;
}

export async function fetchStablecoinPegs(): Promise<StablecoinPegQuote[]> {
  try {
    const res = await fetch(
      "https://stablecoins.llama.fi/stablecoins?includePrices=true",
      {
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      peggedAssets?: Array<{ symbol?: string; price?: number }>;
    };
    const targets: Record<string, string> = {
      USDT: "INFRA_USDT",
      USDC: "INFRA_USDC",
    };
    const out: StablecoinPegQuote[] = [];
    for (const asset of json.peggedAssets ?? []) {
      const sym = asset.symbol?.toUpperCase() ?? "";
      if (targets[sym] && typeof asset.price === "number") {
        out.push({
          symbol: sym,
          nodeId: targets[sym],
          price: asset.price,
          pegDeviationBps: Number(((asset.price - 1) * 10_000).toFixed(1)),
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface MacroFxSnapshot {
  eurPerUsd: number;
  jpyPerUsd: number;
  gbpPerUsd: number;
  dxyProxy: number;
}

export async function fetchMacroFxProxy(): Promise<MacroFxSnapshot | null> {
  try {
    const res = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=EUR,JPY,GBP",
      {
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      rates?: { EUR?: number; JPY?: number; GBP?: number };
    };
    const eur = json.rates?.EUR;
    const jpy = json.rates?.JPY;
    const gbp = json.rates?.GBP;
    if (!eur || !jpy || !gbp) return null;

    const dxyProxy = Number(
      (
        50.14348112 *
        Math.pow(eur, 0.576) *
        Math.pow(jpy, 0.136) *
        Math.pow(gbp, 0.119)
      ).toFixed(2),
    );
    return { eurPerUsd: eur, jpyPerUsd: jpy, gbpPerUsd: gbp, dxyProxy };
  } catch {
    return null;
  }
}

export async function fetchFearAndGreed(): Promise<{
  value: number;
  classification: string;
} | null> {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1", {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: Array<{ value: string; value_classification: string }>;
    };
    const item = json.data?.[0];
    if (!item) return null;
    return {
      value: Number(item.value),
      classification: item.value_classification,
    };
  } catch {
    return null;
  }
}

export async function fetchNasdaqEquityQuote(
  symbol: string,
): Promise<{ symbol: string; price: number; changePct: number } | null> {
  try {
    const res = await fetch(
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/info?assetclass=stocks`,
      {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        primaryData?: {
          lastSalePrice?: string;
          percentageChange?: string;
        };
      };
    };
    const pd = json.data?.primaryData;
    if (!pd?.lastSalePrice) return null;
    const price = Number(pd.lastSalePrice.replace(/[^0-9.-]/g, ""));
    const changePct = Number(
      (pd.percentageChange ?? "0").replace(/[^0-9.-]/g, ""),
    );
    if (!Number.isFinite(price) || price <= 0) return null;
    return { symbol, price, changePct };
  } catch {
    return null;
  }
}

export async function fetchDefiLlamaTopProtocols(
  limit = 15,
): Promise<
  Array<{ name: string; symbol: string; tvlUsd: number; category: string }>
> {
  try {
    const res = await fetch("https://api.llama.fi/protocols", {
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{
      name?: string;
      symbol?: string;
      tvl?: number;
      category?: string;
    }>;
    return data
      .filter((d) => typeof d.tvl === "number" && d.tvl > 0 && d.name)
      .sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0))
      .slice(0, limit)
      .map((d) => ({
        name: d.name!,
        symbol: d.symbol && d.symbol !== "-" ? d.symbol : "",
        tvlUsd: d.tvl!,
        category: d.category ?? "DeFi",
      }));
  } catch {
    return [];
  }
}

export async function fetchDeribitDvol(
  currency: "BTC" | "ETH" = "BTC",
): Promise<{ currency: "BTC" | "ETH"; dvolPct: number } | null> {
  try {
    const now = Date.now();
    const url = `https://www.deribit.com/api/v2/public/get_volatility_index_data?currency=${currency}&start_timestamp=${now - 7200_000}&end_timestamp=${now}&resolution=3600`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: { data?: Array<[number, number, number, number, number]> };
    };
    const rows = json.result?.data ?? [];
    if (rows.length === 0) return null;
    const latestClose = rows[rows.length - 1][4];
    if (!Number.isFinite(latestClose)) return null;
    return { currency, dvolPct: Number(latestClose.toFixed(2)) };
  } catch {
    return null;
  }
}

export interface SecFilingSummary {
  nodeId: string;
  ticker: string;
  recentForm4Count30d: number;
  latestFiling: string;
}

export async function fetchSecRecentFilings(
  nodeId: string,
  ticker: string,
  cik10: string,
): Promise<SecFilingSummary | null> {
  try {
    const res = await fetch(
      `https://data.sec.gov/submissions/CIK${cik10}.json`,
      {
        headers: {
          "User-Agent": "MalCryptoAladdin/1.0 (research@malcrypto.local)",
        },
        signal: AbortSignal.timeout(6000),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      filings?: {
        recent?: {
          form?: string[];
          filingDate?: string[];
        };
      };
    };
    const forms = json.filings?.recent?.form ?? [];
    const dates = json.filings?.recent?.filingDate ?? [];
    if (forms.length === 0) return null;

    const cutoffMs = Date.now() - 30 * 86400_000;
    let form4Count = 0;
    for (let i = 0; i < Math.min(forms.length, 40); i++) {
      const f = forms[i];
      const dMs = Date.parse(dates[i] ?? "");
      if (dMs >= cutoffMs && (f === "4" || f === "4/A" || f === "144")) {
        form4Count++;
      }
    }

    return {
      nodeId,
      ticker,
      recentForm4Count30d: form4Count,
      latestFiling: `${forms[0]}@${dates[0]}`,
    };
  } catch {
    return null;
  }
}

export interface OhlcvCandle {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function fetchBinanceKlinesOhlcv(
  symbol = "BTCUSDT",
  interval = "15m",
  limit = 200,
): Promise<OhlcvCandle[]> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return [];
    const rows = (await res.json()) as Array<Array<string | number>>;
    return rows
      .map((r) => ({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closeTime: Number(r[6]),
      }))
      .filter((c) => Number.isFinite(c.close) && c.close > 0);
  } catch {
    return [];
  }
}

export interface DeribitOptionsSummary {
  currency: "BTC" | "ETH";
  totalOpenInterest: number;
  putOpenInterest: number;
  callOpenInterest: number;
  putCallRatio: number;
  avgMarkIvPct: number;
}

export async function fetchDeribitOptionsSummary(
  currency: "BTC" | "ETH" = "BTC",
): Promise<DeribitOptionsSummary | null> {
  try {
    const url = `https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=${currency}&kind=option`;
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      result?: Array<{
        instrument_name?: string;
        open_interest?: number;
        mark_iv?: number;
      }>;
    };
    const items = json.result ?? [];
    if (items.length === 0) return null;
    let putOi = 0;
    let callOi = 0;
    let ivWeightedSum = 0;
    let ivOiSum = 0;
    for (const it of items) {
      const name = it.instrument_name ?? "";
      const oi = Number(it.open_interest ?? 0);
      const iv = Number(it.mark_iv ?? 0);
      if (oi <= 0) continue;
      if (name.endsWith("-P")) putOi += oi;
      else if (name.endsWith("-C")) callOi += oi;
      if (iv > 0 && iv < 300) {
        ivWeightedSum += iv * oi;
        ivOiSum += oi;
      }
    }
    const total = putOi + callOi;
    if (total <= 0) return null;
    return {
      currency,
      totalOpenInterest: Number(total.toFixed(1)),
      putOpenInterest: Number(putOi.toFixed(1)),
      callOpenInterest: Number(callOi.toFixed(1)),
      putCallRatio: Number((putOi / Math.max(1, callOi)).toFixed(3)),
      avgMarkIvPct:
        ivOiSum > 0 ? Number((ivWeightedSum / ivOiSum).toFixed(2)) : 0,
    };
  } catch {
    return null;
  }
}

export interface MempoolOnchainSnapshot {
  fastestFeeSatVb: number;
  halfHourFeeSatVb: number;
  mempoolTxCount: number;
  mempoolVsizeMb: number;
}

export async function fetchMempoolOnchain(): Promise<MempoolOnchainSnapshot | null> {
  try {
    const [feeRes, memRes] = await Promise.all([
      fetch("https://mempool.space/api/v1/fees/recommended", {
        signal: AbortSignal.timeout(5000),
      }),
      fetch("https://mempool.space/api/mempool", {
        signal: AbortSignal.timeout(5000),
      }),
    ]);
    if (!feeRes.ok || !memRes.ok) return null;
    const fees = (await feeRes.json()) as {
      fastestFee?: number;
      halfHourFee?: number;
    };
    const mem = (await memRes.json()) as { count?: number; vsize?: number };
    return {
      fastestFeeSatVb: Number(fees.fastestFee ?? 0),
      halfHourFeeSatVb: Number(fees.halfHourFee ?? 0),
      mempoolTxCount: Number(mem.count ?? 0),
      mempoolVsizeMb: Number(((mem.vsize ?? 0) / 1_000_000).toFixed(2)),
    };
  } catch {
    return null;
  }
}

export async function fetchFearAndGreedHistory(
  limit = 90,
): Promise<
  Array<{ timestamp: number; value: number; classification: string }>
> {
  try {
    const res = await fetch(`https://api.alternative.me/fng/?limit=${limit}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      data?: Array<{
        value: string;
        value_classification: string;
        timestamp: string;
      }>;
    };
    return (json.data ?? [])
      .map((d) => ({
        timestamp: Number(d.timestamp) * 1000,
        value: Number(d.value),
        classification: d.value_classification,
      }))
      .filter((d) => Number.isFinite(d.value) && Number.isFinite(d.timestamp))
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

export interface ExternalNewsItem {
  id: string;
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  category: "CRYPTO" | "MACRO" | "REGULATORY" | "ONCHAIN" | "DERIVATIVES";
}

export async function fetchCryptoCompareNews(
  limit = 25,
): Promise<ExternalNewsItem[]> {
  try {
    const res = await fetch(
      "https://min-api.cryptocompare.com/data/v2/news/?lang=EN",
      { signal: AbortSignal.timeout(6000) },
    );
    if (!res.ok) return [];
    const json = (await res.json()) as {
      Data?: Array<{
        id?: string;
        title?: string;
        url?: string;
        source?: string;
        published_on?: number;
      }>;
    };
    return (json.Data ?? [])
      .filter((d) => d.title && d.url)
      .slice(0, limit)
      .map((d) => ({
        id: `cc_${d.id ?? d.published_on ?? Math.random()}`,
        title: d.title!.trim(),
        url: d.url!,
        source: d.source ?? "CryptoCompare",
        publishedAt: (d.published_on ?? Math.floor(Date.now() / 1000)) * 1000,
        category: "CRYPTO" as const,
      }));
  } catch {
    return [];
  }
}

export async function fetchRssHeadlines(
  feedUrl: string,
  sourceName: string,
  category: ExternalNewsItem["category"],
  limit = 15,
): Promise<ExternalNewsItem[]> {
  try {
    const res = await fetch(feedUrl, {
      headers: { "User-Agent": "MalCryptoAladdin/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const items: ExternalNewsItem[] = [];
    const itemRegex = /<(?:item|entry)\b[^>]*>([\s\S]*?)<\/(?:item|entry)>/gi;
    let match: RegExpExecArray | null;
    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1];
      const titleMatch = block.match(
        /<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i,
      );
      const linkHrefMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i);
      const linkTextMatch = block.match(
        /<link[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/i,
      );
      const dateMatch = block.match(
        /<(?:pubDate|updated|published)[^>]*>([\s\S]*?)<\/(?:pubDate|updated|published)>/i,
      );
      const rawTitle = (titleMatch?.[1] ?? "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      const rawUrl = (linkHrefMatch?.[1] ?? linkTextMatch?.[1] ?? "").trim();
      const ts = dateMatch?.[1] ? Date.parse(dateMatch[1].trim()) : Date.now();
      if (rawTitle.length > 8 && rawUrl) {
        items.push({
          id: `rss_${sourceName}_${Math.abs(hashStr(rawTitle))}`,
          title: rawTitle,
          url: rawUrl,
          source: sourceName,
          publishedAt: Number.isFinite(ts) ? ts : Date.now(),
          category,
        });
      }
    }
    return items;
  } catch {
    return [];
  }
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}
