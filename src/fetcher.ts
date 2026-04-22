import { Ticker } from "./types.js";
import { getDecimalsForCurrency, unscaleBinPrice } from "./utils.js";

// Provisional combined endpoint — replaces the previous pair of
// `/ticker` (classic) + `/api/app/v1/tickers` (HODLMM) feeds. URL is
// expected to change when the endpoint is promoted out of test.
const TICKER_URL = "https://api.bitflowapis.finance/tickerTest";

// The combined feed mixes two price encodings in a single payload: DLMM /
// HODLMM rows publish scaled (raw micro-unit) prices, while classic
// (xyk / stableswap) rows publish actual human-readable prices. Downstream
// code assumes scaled input, so classic rows are converted at ingest.
function priceEncodingForPool(poolId: string): "scaled" | "actual" {
  return poolId.startsWith("dlmm_") ? "scaled" : "actual";
}

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

function normalizeTicker(raw: Record<string, unknown>): Ticker {
  const baseCurrency = normalizeCurrency(raw.base_currency);
  const targetCurrency = normalizeCurrency(raw.target_currency);
  const poolId = String(raw.pool_id ?? "");
  const encoding = priceEncodingForPool(poolId);

  return {
    ticker_id: normalizeTickerId(raw.ticker_id, baseCurrency, targetCurrency),
    base_currency: baseCurrency,
    target_currency: targetCurrency,
    last_price: normalizePriceField(raw.last_price, baseCurrency, targetCurrency, encoding),
    base_volume: String(raw.base_volume ?? 0),
    target_volume: String(raw.target_volume ?? 0),
    pool_id: poolId,
    liquidity_in_usd: String(raw.liquidity_in_usd ?? 0),
    bid: normalizePriceField(raw.bid, baseCurrency, targetCurrency, encoding),
    ask: normalizePriceField(raw.ask, baseCurrency, targetCurrency, encoding),
    high: normalizePriceField(raw.high, baseCurrency, targetCurrency, encoding),
    low: normalizePriceField(raw.low, baseCurrency, targetCurrency, encoding),
  };
}

export async function fetchTickers(): Promise<Ticker[]> {
  const response = await fetch(TICKER_URL, {
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

  const merged = new Map<string, Ticker>();
  for (const item of data) {
    const ticker = normalizeTicker(item as Record<string, unknown>);
    merged.set(ticker.pool_id, ticker);
  }

  return Array.from(merged.values());
}
