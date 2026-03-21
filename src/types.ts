export interface Ticker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  pool_id: string;
  liquidity_in_usd: string;
  bid: string;
  ask: string;
  high: string;
  low: string;
  source?: "classic" | "hodlmm";
}

export interface Snapshot {
  timestamp: string; // ISO 8601
  tickers: Ticker[];
}

export interface FieldVariance {
  current: number;
  previous: number;
  absolute: number;
  percent: number | null; // null when previous is 0
}

export interface PoolVariance {
  pool_id: string;
  ticker_id: string;
  last_price: FieldVariance;
  base_volume: FieldVariance;
  target_volume: FieldVariance;
  base_price_usd?: FieldVariance | null;
}

export interface IntervalReport {
  interval: string;
  snapshot_age_minutes: number;
  snapshot_timestamp: string;
  pools: PoolVariance[];
  pricing?: PricingResult;
}

export interface SavedReport extends IntervalReport {
  run_at: string;
}

export interface PoolPriceUSD {
  pool_id: string;
  ticker_id: string;
  base_symbol: string;
  target_symbol: string;
  scaled_price: number;
  base_price_usd: number | null;
  resolution: 'direct' | 'cross-pair' | 'failed';
}

export interface AggregatedPrice {
  symbol: string;
  internal_price_usd: number | null;
  reference_price_usd: number | null;
  reference_source: 'coingecko' | 'fixed-peg';
  external_price_usd?: number | null; // legacy field for older saved reports
  divergence_pct: number | null;
  tolerance_pct: number;
  is_divergent: boolean;
  pool_count: number;
  total_volume_usd: number;
  unsupported_pool_count: number;
  resolution: 'vwap' | 'implied' | 'unavailable';
  warnings: string[];
}

export interface PricingResult {
  timestamp: string;
  pool_prices: PoolPriceUSD[];
  aggregated: AggregatedPrice[];
}
