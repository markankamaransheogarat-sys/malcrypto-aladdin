/**
 * Browser-Native Neural Engine Worker (Mode 2: WebGPU / WASM via Transformers.js v3)
 * Lazy-loads quantized ONNX models from Hugging Face CDN and caches them in browser Cache API.
 */

export interface AiWorkerRequest {
  type: "INIT" | "ANALYZE";
  id: number;
  text?: string;
}

type PipelineFn = (
  task: string,
  model: string,
  opts?: Record<string, unknown>,
) => Promise<unknown>;

let sentimentPipe:
  ((text: string) => Promise<Array<{ label: string; score: number }>>) | null =
  null;
let zeroShotPipe:
  | ((
      text: string,
      labels: string[],
    ) => Promise<{ labels: string[]; scores: number[] }>)
  | null = null;

async function ensureModelsLoaded(): Promise<{ backend: string }> {
  if (sentimentPipe && zeroShotPipe) return { backend: "cached" };

  const cdnUrl =
    "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.4.0/+esm";
  const mod = (await import(/* @vite-ignore */ cdnUrl)) as {
    pipeline: PipelineFn;
    env: { allowLocalModels: boolean };
  };
  mod.env.allowLocalModels = false;

  const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const device = hasWebGpu ? "webgpu" : "wasm";

  sentimentPipe = (await mod.pipeline(
    "text-classification",
    "Xenova/distilbert-base-uncased-finetuned-sst-2-english",
    { device, dtype: "q8" },
  )) as typeof sentimentPipe;

  zeroShotPipe = (await mod.pipeline(
    "zero-shot-classification",
    "Xenova/mobilebert-uncased-mnli",
    { device, dtype: "q8" },
  )) as typeof zeroShotPipe;

  return { backend: device };
}

self.onmessage = async (ev: MessageEvent<AiWorkerRequest>) => {
  const { type, id, text } = ev.data;
  try {
    if (type === "INIT") {
      const info = await ensureModelsLoaded();
      self.postMessage({ id, ok: true, type: "INIT", backend: info.backend });
      return;
    }

    if (type === "ANALYZE" && text) {
      await ensureModelsLoaded();
      const [sentRes, clsRes] = await Promise.all([
        sentimentPipe!(text),
        zeroShotPipe!(text, [
          "earnings guidance",
          "central bank macro policy",
          "regulatory lawsuit",
          "security hack exploit",
          "liquidity flow",
          "market narrative",
        ]),
      ]);

      const topSent = sentRes[0];
      const sentiment = topSent.label.toUpperCase().includes("NEG")
        ? -topSent.score
        : topSent.score;

      const labelMap: Record<string, string> = {
        "earnings guidance": "EARNINGS_GUIDANCE",
        "central bank macro policy": "MACRO_POLICY",
        "regulatory lawsuit": "REGULATION",
        "security hack exploit": "HACK_EXPLOIT",
        "liquidity flow": "LIQUIDITY_FLOW",
        "market narrative": "NARRATIVE",
      };
      const category = labelMap[clsRes.labels[0]] ?? "NARRATIVE";

      self.postMessage({
        id,
        ok: true,
        type: "ANALYZE",
        sentiment: Number(sentiment.toFixed(3)),
        category,
      });
    }
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
