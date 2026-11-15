import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";

// Token usage from a response body, streamed (SSE) or whole. Both Claude and Codex report
// usage in their final events, so the last value seen for each counter is the one that counts.

export const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

/**
 * The response body as text. The proxy forwards the CLI's accept-encoding, so the upstream
 * usually compresses what it sends back, and the bytes are unreadable until they are inflated.
 */
export function decodeBody(buffer, encoding = "") {
  const enc = String(encoding).toLowerCase();
  if (enc.includes("br")) return brotliDecompressSync(buffer).toString("utf8");
  if (enc.includes("gzip")) return gunzipSync(buffer).toString("utf8");
  if (enc.includes("deflate")) return inflateSync(buffer).toString("utf8");
  return buffer.toString("utf8");
}

/** Usage from a raw response, or null when it cannot be read: never zeros passed off as data. */
export function usageFromBody(buffer, encoding) {
  try {
    const usage = parseUsage(decodeBody(buffer, encoding));
    return Object.values(usage).some(Boolean) ? usage : null;
  } catch {
    return null;
  }
}

/**
 * Reads the usage counters out of a complete response body.
 *
 * Claude: `message_start` carries input and cache counts, `message_delta` the running output.
 * Codex:  `response.completed` carries everything, with cached input nested under details.
 * `input` is uncached input only, so cache reads are not counted twice.
 */
export function parseUsage(text) {
  const usage = emptyUsage();
  const payloads = /^data:/m.test(text)
    ? [...text.matchAll(/^data:\s*(.*)$/gm)].map((match) => match[1])
    : [text];
  for (const payload of payloads) {
    let event;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const claude = event.message?.usage ?? event.usage;
    if (claude && (claude.input_tokens != null || claude.output_tokens != null)) {
      usage.input = claude.input_tokens ?? usage.input;
      usage.output = claude.output_tokens ?? usage.output;
      usage.cacheRead = claude.cache_read_input_tokens ?? usage.cacheRead;
      usage.cacheWrite = claude.cache_creation_input_tokens ?? usage.cacheWrite;
    }
    const codex = event.response?.usage;
    if (codex) {
      const cached = codex.input_tokens_details?.cached_tokens ?? 0;
      usage.input = (codex.input_tokens ?? 0) - cached;
      usage.cacheRead = cached;
      usage.output = codex.output_tokens ?? usage.output;
    }
  }
  return usage;
}

/**
 * Prices per million tokens, from JEV_PRICES, e.g.
 * {"haiku":{"input":1,"output":5,"cacheRead":0.1,"cacheWrite":1.25}}.
 * Nothing is built in: prices change, so a cost is shown only for prices you supply.
 */
export function priceTable(env = process.env) {
  try {
    return JSON.parse(env.JEV_PRICES ?? "{}");
  } catch {
    return {};
  }
}

/** Estimated cost in the same currency as the prices, or null when the tier is unpriced. */
export function costOf(usage, price) {
  if (!price) return null;
  const counters = ["input", "output", "cacheRead", "cacheWrite"];
  return counters.reduce((sum, k) => sum + ((usage[k] ?? 0) * (price[k] ?? 0)) / 1_000_000, 0);
}
