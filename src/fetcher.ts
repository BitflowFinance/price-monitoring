import { Ticker } from "./types.js";
import { getDecimalsForCurrency, unscaleBinPrice } from "./utils.js";

const TICKER_SOURCES = [
  {
    name: "classic" as const,
    url: "https://api.bitflowapis.finance/ticker",
    priceEncoding: "actual" as const,
  },
  {
    name: "hodlmm" as const,
    url: "https://bff.bitflowapis.finance/api/app/v1/tickers",
    priceEncoding: "scaled" as const,
  },
];

function normalizeCurrency(currency: unknown): string {
  if (currency == null) return "";
  const value = String(currency);
  return value === "Stacks" ? "STX" : value;
}

function normalizeTickerId(rawTickerId: unknown, baseCurrency: string, targetCurrency: string): string {
  const value = rawTickerId == null ? "" : String(rawTickerId);
  const idx = value.indexOf("_");
  if (idx < 0) return `${baseCurrency}_${targetCurrency}`;
  return `${normalizeCurrency(value.slice(0, idx))}_${normalizeCurrency(value.slice(idx + 1))}`;
}

function normalizePriceField(
  value: unknown,
  baseCurrency: string,
  targetCurrency: string,
  encoding: "actual" | "scaled"
): string {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) return "0";
  if (encoding === "scaled") return String(numeric);
  const decimalsX = getDecimalsForCurrency(baseCurrency);
  const decimalsY = getDecimalsForCurrency(targetCurrency);
  return String(unscaleBinPrice(numeric, decimalsX, decimalsY));
}

function normalizeTicker(
  raw: Record<string, unknown>,
  source: "classic" | "hodlmm",
  encoding: "actual" | "scaled"
): Ticker {
  const baseCurrency = normalizeCurrency(raw.base_currency);
  const targetCurrency = normalizeCurrency(raw.target_currency);

  return {
    ticker_id: normalizeTickerId(raw.ticker_id, baseCurrency, targetCurrency),
    base_currency: baseCurrency,
    target_currency: targetCurrency,
    last_price: normalizePriceField(raw.last_price, baseCurrency, targetCurrency, encoding),
    base_volume: String(raw.base_volume ?? 0),
    target_volume: String(raw.target_volume ?? 0),
    pool_id: String(raw.pool_id ?? ""),
    liquidity_in_usd: String(raw.liquidity_in_usd ?? 0),
    bid: normalizePriceField(raw.bid, baseCurrency, targetCurrency, encoding),
    ask: normalizePriceField(raw.ask, baseCurrency, targetCurrency, encoding),
    high: normalizePriceField(raw.high, baseCurrency, targetCurrency, encoding),
    low: normalizePriceField(raw.low, baseCurrency, targetCurrency, encoding),
    source,
  };
}

async function fetchSource(
  url: string,
  source: "classic" | "hodlmm",
  encoding: "actual" | "scaled"
): Promise<Ticker[]> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (!Array.isArray(data)) {
    throw new Error(`Unexpected response shape: expected array`);
  }

  return data.map((item) => normalizeTicker(item as Record<string, unknown>, source, encoding));
}

export async function fetchTickers(): Promise<Ticker[]> {
  const results = await Promise.allSettled(
    TICKER_SOURCES.map((source) => fetchSource(source.url, source.name, source.priceEncoding))
  );

  const merged = new Map<string, Ticker>();
  const failures: string[] = [];

  results.forEach((result, idx) => {
    const source = TICKER_SOURCES[idx];
    if (result.status === "rejected") {
      failures.push(`${source.name}: ${result.reason}`);
      return;
    }
    for (const ticker of result.value) {
      // Later sources win on collision. This prefers HODLMM over classic if the
      // production feed ever starts duplicating pool IDs across endpoints.
      merged.set(ticker.pool_id, ticker);
    }
  });

  if (merged.size === 0) {
    throw new Error(`All ticker sources failed. ${failures.join(" | ")}`);
  }

  if (failures.length > 0) {
    console.warn(`[fetcher] Partial source failure: ${failures.join(" | ")}`);
  }

  return Array.from(merged.values());
}
