/**
 * Direct Telegram Quant Alert Webhook Bridge
 */

import type { SimulationResult } from "../core/types.js";

export async function sendTelegramCascadeAlert(
  botToken: string,
  chatId: string,
  sim: SimulationResult,
): Promise<boolean> {
  if (!botToken || !chatId) return false;

  const top3 = sim.affectedNodes
    .slice(0, 4)
    .map(
      (n) =>
        `• ${n.label} (hop ${n.hop}, ~${n.etaMinutes}m): ${n.expectedMovePct > 0 ? "+" : ""}${n.expectedMovePct}% [P10: ${n.p10MovePct}% | P90: ${n.p90MovePct}%]`,
    )
    .join("\n");

  const scenarios = sim.scenarios
    .map(
      (s) =>
        `• ${s.label}: ${(s.probability * 100).toFixed(0)}% (BTC ${s.btcExpectedPct > 0 ? "+" : ""}${s.btcExpectedPct}%)`,
    )
    .join("\n");

  const text = [
    `🕸️ *MALCRYPTO ALADDIN CASCADE ALERT*`,
    `*Trigger:* ${sim.triggerLabel} (${sim.shockPct > 0 ? "+" : ""}${sim.shockPct}%)`,
    `*Regime:* \`${sim.regime}\` | *Risk Score:* ${sim.totalSystemicRiskScore}/100`,
    ``,
    `*Contagion Path:*`,
    top3 || "• No secondary propagation above threshold",
    ``,
    `*Scenario Tree:*`,
    scenarios,
  ].join("\n");

  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "Markdown",
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}
