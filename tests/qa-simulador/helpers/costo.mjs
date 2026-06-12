// tests/qa-simulador/helpers/costo.mjs — Dieta de tokens: cada
// certificación dice lo que costó. Acumula el usage real que devuelve la
// API por actor (mateo/cliente/juez) y lo convierte a USD con la tarifa
// del modelo usado.

// USD por 1M tokens. Fuente: pricing Anthropic (mismas constantes que
// api/health.js para Sonnet).
export const TARIFAS = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

export function crearMedidor() {
  const porActor = {};

  return {
    add(actor, model, usage) {
      if (!usage) return;
      const a = (porActor[actor] ||= { model, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, llamadas: 0 });
      a.llamadas += 1;
      a.input += usage.input_tokens || 0;
      a.output += usage.output_tokens || 0;
      a.cacheWrite += usage.cache_creation_input_tokens || 0;
      a.cacheRead += usage.cache_read_input_tokens || 0;
    },

    resumen() {
      let totalUsd = 0;
      const actores = {};
      for (const [actor, a] of Object.entries(porActor)) {
        const t = TARIFAS[a.model] || TARIFAS["claude-sonnet-4-6"];
        const usd =
          (a.input * t.input + a.output * t.output + a.cacheWrite * t.cacheWrite + a.cacheRead * t.cacheRead) / 1e6;
        totalUsd += usd;
        actores[actor] = { ...a, usd: Math.round(usd * 10000) / 10000 };
      }
      return { actores, totalUsd: Math.round(totalUsd * 10000) / 10000 };
    },
  };
}

export function formatoCosto(resumen) {
  const lineas = Object.entries(resumen.actores).map(
    ([actor, a]) =>
      "  " + actor + " (" + a.model.replace("claude-", "") + "): " + a.llamadas + " llamadas · in " +
      a.input.toLocaleString() + " · out " + a.output.toLocaleString() +
      " · cacheW " + a.cacheWrite.toLocaleString() + " · cacheR " + a.cacheRead.toLocaleString() +
      " → $" + a.usd.toFixed(4)
  );
  return "💰 COSTO DEL RUN: $" + resumen.totalUsd.toFixed(4) + " USD\n" + lineas.join("\n");
}
