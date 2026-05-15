import { Ticker } from "./types.js";
import { getDecimalsForCurrency, unscaleBinPrice } from "./utils.js";

// Unified Bitflow ticker endpoint for classic and HODLMM pools.
const TICKER_URL = "https://api.bitflowapis.finance/ticker";

// HODLMM pools are owned by a dedicated deployer. Classic pools can come from
// several deployers, so a non-HODLMM deployer is treated as classic.
const HODLMM_DEPLOYERS = new Set([
  "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD",
]);

export function sourceForPool(poolId: string): "hodlmm" | "classic" {
  // Legacy HODLMM snapshots used synthetic IDs like `dlmm_3`.
  if (poolId.startsWith("dlmm_")) return "hodlmm";
  const [deployer, contractName = ""] = poolId.split(".");
  if (HODLMM_DEPLOYERS.has(deployer) || contractName.startsWith("dlmm-pool-")) {
    return "hodlmm";
  }
  return "classic";
}

// Live ticker APIs currently publish human-readable prices for both classic and
// HODLMM rows. Downstream code stores scaled prices, so live rows are converted
// at ingest regardless of pool family.
function priceEncodingForPool(_poolId: string): "actual" {
  return "actual";
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
    source: sourceForPool(poolId),
  };
}

async function fetchSource(url: string): Promise<Ticker[]> {
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

  return data.map((item) => normalizeTicker(item as Record<string, unknown>));
}

export async function fetchTickers(): Promise<Ticker[]> {
  const merged = new Map<string, Ticker>();
  for (const ticker of await fetchSource(TICKER_URL)) {
    if (ticker.pool_id) merged.set(ticker.pool_id, ticker);
  }
  return Array.from(merged.values());
}
