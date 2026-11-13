/**
 * Browser IndexedDB Persistence Layer for Bi-Temporal Graph, News & Calibration
 */

import type { BriefVerdictRecord } from "../aladdin/briefing.js";
import type { PortfolioPosition } from "../aladdin/portfolio.js";
import type { NewsEvent, PredictionRecord } from "../core/types.js";
import type { GraphSnapshot } from "../graph/temporal-graph.js";

const DB_NAME = "malcrypto_aladdin_db";
const DB_VERSION = 1;
const STORE_KV = "kv_store";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KV)) {
        db.createObjectStore(STORE_KV);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putKV<T>(key: string, value: T): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_KV, "readwrite");
      tx.objectStore(STORE_KV).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Non-browser environment or storage quota fallback
  }
}

async function getKV<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    const val = await new Promise<T | null>((resolve, reject) => {
      const tx = db.transaction(STORE_KV, "readonly");
      const req = tx.objectStore(STORE_KV).get(key);
      req.onsuccess = () => resolve((req.result as T) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return val;
  } catch {
    return null;
  }
}

export const idbStore = {
  saveGraphSnapshot: (snap: GraphSnapshot) => putKV("graph_snapshot", snap),
  loadGraphSnapshot: () => getKV<GraphSnapshot>("graph_snapshot"),
  saveNews: (items: NewsEvent[]) => putKV("news_events", items.slice(0, 200)),
  loadNews: () => getKV<NewsEvent[]>("news_events"),
  savePredictions: (preds: PredictionRecord[]) =>
    putKV("predictions", preds.slice(0, 500)),
  loadPredictions: () => getKV<PredictionRecord[]>("predictions"),
  savePortfolio: (pos: PortfolioPosition[]) => putKV("portfolio", pos),
  loadPortfolio: () => getKV<PortfolioPosition[]>("portfolio"),
  saveBriefVerdicts: (records: BriefVerdictRecord[]) =>
    putKV("brief_verdicts", records.slice(-200)),
  loadBriefVerdicts: () => getKV<BriefVerdictRecord[]>("brief_verdicts"),
};
