import { COINGECKO_IDS } from "./tokens.js";

const COINGECKO_URL = "https://pro-api.coingecko.com/api/v3/simple/price";
const FETCH_TIMEOUT_MS = 15_000;

// Returns a map of symbol → USD price (e.g. { STX: 0.26, sBTC: 95000, aeUSDC: 1.00 })
// On partial failure, logs a warning and returns whatever was fetched.
export async function fetchExternalPrices(): Promise<Record<string, number>> {
  const apiKey = process.env.COINGECKO_API_KEY;
  if (!apiKey) {
    console.warn("[external-prices] COINGECKO_API_KEY not set — skipping external price fetch");
    return {};
  }

  // Build the unique set of CoinGecko IDs we need
  const idSet = new Set(Object.values(COINGECKO_IDS));
  const ids = Array.from(idSet).join(",");

  const url = `${COINGECKO_URL}?ids=${ids}&vs_currencies=usd`;

  let raw: Record<string, { usd: number }>;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      headers: { "x-cg-pro-api-key": apiKey },
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[external-prices] CoinGecko responded ${res.status} ${res.statusText}`);
      return {};
    }
    raw = await res.json();
  } catch (err) {
    console.warn("[external-prices] Failed to fetch external prices:", err);
    return {};
  }

  // Map CoinGecko IDs back to our token symbols
  // When multiple symbols share an ID (all stablecoins → usd-coin), each gets the same price
  const result: Record<string, number> = {};
  for (const [symbol, geckoId] of Object.entries(COINGECKO_IDS)) {
    const price = raw[geckoId]?.usd;
    if (price != null) {
      result[symbol] = price;
    } else {
      console.warn(`[external-prices] No price returned for ${symbol} (id: ${geckoId})`);
    }
  }

  return result;
}
