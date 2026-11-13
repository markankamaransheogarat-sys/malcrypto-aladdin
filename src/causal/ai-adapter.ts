/**
 * Pluggable AI News & Causal Reasoning Adapter (Phase 3)
 * Mode 0: Algorithmic Zero-Cost Baseline
 * Mode 1: Ollama / OpenAI-Compatible Endpoint (local or API)
 * Mode 2: Browser-Native Neural Engine (WebGPU / WASM via Transformers.js in ai-worker.ts)
 */

import { clamp } from "../core/math.js";
import type { NewsEvent } from "../core/types.js";

export type AiEngineMode = "ALGORITHMIC" | "WEBGPU_LOCAL" | "OLLAMA_OPENAI";

export interface AiConfig {
  mode: AiEngineMode;
  endpointUrl?: string;
  apiKey?: string;
  modelName?: string;
}

export interface AiAnalysisResult {
  sentiment: number;
  category: NewsEvent["category"];
  entities: string[];
  reasoning?: string;
}

export async function analyzeWithOpenAICompatible(
  title: string,
  config: AiConfig,
): Promise<AiAnalysisResult | null> {
  const url =
    config.endpointUrl?.trim() || "http://localhost:11434/v1/chat/completions";
  const model = config.modelName?.trim() || "qwen2.5:7b";

  const systemPrompt =
    "You are an institutional cross-market risk analyst. Return ONLY valid JSON with keys: " +
    '{"sentiment": number (-1..1), "category": "EARNINGS_GUIDANCE"|"MACRO_POLICY"|"REGULATION"|"HACK_EXPLOIT"|"LIQUIDITY_FLOW"|"NARRATIVE", "entities": string[], "reasoning": string}.';

  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

    const res = await fetch(url, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(12000),
      body: JSON.stringify({
        model,
        temperature: 0.1,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Analyze market impact of headline: "${title}"`,
          },
        ],
      }),
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = data.choices?.[0]?.message?.content ?? "";
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]) as Partial<AiAnalysisResult>;
    return {
      sentiment: clamp(Number(parsed.sentiment ?? 0), -1, 1),
      category: parsed.category ?? "NARRATIVE",
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map(String)
        : [],
      reasoning: parsed.reasoning ? String(parsed.reasoning) : undefined,
    };
  } catch {
    return null;
  }
}
