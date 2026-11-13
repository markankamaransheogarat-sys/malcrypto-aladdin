/**
 * Dedicated WebWorker for Off-Main-Thread Causal Discovery (Granger + Tail-Beta + FDR)
 * Keeps the 60 FPS Maltego Graph smooth during heavy matrix scans.
 */

import { CausalDiscoveryEngine } from "../causal/lead-lag.js";

const engine = new CausalDiscoveryEngine();

export interface WorkerRequest {
  id: number;
  entries: Array<[string, number[]]>;
  barMinutes?: number;
  maxLagSteps?: number;
  fdrAlpha?: number;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const {
    id,
    entries,
    barMinutes = 15,
    maxLagSteps = 4,
    fdrAlpha = 0.05,
  } = event.data;
  const map = new Map<string, number[]>(entries);
  const discoveries = engine.discoverLinks(map, {
    barMinutes,
    maxLagSteps,
    fdrAlpha,
  });
  self.postMessage({ id, discoveries });
};
