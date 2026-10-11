import { COINGECKO_IDS } from "./tokens.js";

const COINGECKO_PRO_URL = "https://pro-api.coingecko.com/api/v3/simple/price";
const COINGECKO_PUBLIC_URL = "https://api.coingecko.com/api/v3/simple/price";
const FETCH_TIMEOUT_MS = 15_000;

// Returns a map of symbol → USD price (e.g. { STX: 0.26, sBTC: 95000, aeUSDC: 1.00 })
// On partial failure, logs a warning and returns whatever was fetched.
export async function fetchExternalPrices(): Promise<Record<string, number>> {
  const apiKey = process.env.COINGECKO_API_KEY;

  // Build the unique set of CoinGecko IDs we need
  const idSet = new Set(Object.values(COINGECKO_IDS));
  const ids = Array.from(idSet).join(",");

  const baseUrl = apiKey ? COINGECKO_PRO_URL : COINGECKO_PUBLIC_URL;
  const url = `${baseUrl}?ids=${ids}&vs_currencies=usd`;

  let raw: Record<string, { usd: number }>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: apiKey ? { "x-cg-pro-api-key": apiKey } : undefined,
        signal: controller.signal,
      });

      if (!res.ok) {
        const tier = apiKey ? "Pro" : "public";
        console.warn(`[external-prices] CoinGecko ${tier} API responded ${res.status} ${res.statusText}`);
        return {};
      }

      const body: unknown = await res.json();
      // Defensive: a non-object payload (e.g. an array, string, or null from a
      // misrouted proxy) would otherwise throw a TypeError on the lookup below.
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        console.warn("[external-prices] Unexpected CoinGecko response shape:", typeof body);
        return {};
      }
      raw = body as Record<string, { usd: number }>;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.warn("[external-prices] Failed to fetch external prices:", err);
    return {};
  }

  // Map CoinGecko IDs back to our token symbols
  // When multiple symbols share an ID (all stablecoins → usd-coin), each gets the same price
  const result: Record<string, number> = {};
  for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
    const entry = raw[geckoId];
    const price = entry && typeof entry === "object" && !Array.isArray(entry) ? entry.usd : undefined;
    // Reject non-finite/non-positive prices so a 0 or NaN reference never
    // zeroes out divergence math or hides as a valid external quote.
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      result[symbol] = price;
    } else {
      console.warn(`[external-prices] No valid price returned for ${symbol} (id: ${geckoId})`);
    }
  }

  return result;
}
