import { Ticker, PoolPriceUSD, AggregatedPrice, PricingResult } from "./types.js";
import {
  FIXED_REFERENCE_PRICE_USD,
  isStablecoin,
  tokenSymbol,
  TOLERANCE_PCT,
} from "./tokens.js";
import { scaleBinPrice, getDecimalsForCurrency } from "./utils.js";

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

function vwap(entries: { price: number; volumeUsd: number }[]): number | null {
  const active = entries.filter(e => e.volumeUsd > 0);
  if (!active.length) return null;
  const sumPV = active.reduce((s, e) => s + e.price * e.volumeUsd, 0);
  const sumV  = active.reduce((s, e) => s + e.volumeUsd, 0);
  return sumV > 0 ? sumPV / sumV : null;
}

// ─────────────────────────────────────────────────────────
// Core engine
// ─────────────────────────────────────────────────────────

export function computePricing(
  tickers: Ticker[],
  externalPrices: Record<string, number>
): PricingResult {
  const poolPrices: PoolPriceUSD[] = [];

  // Keyed by base_symbol for VWAP aggregation
  // Each entry: { price: base_price_usd, volumeUsd }
  const vwapEntries: Record<string, { price: number; volumeUsd: number }[]> = {};

  // Side structure for Phase 2.5: stablecoin-target pool data
  const stablecoinPools: { baseSymbol: string; targetSymbol: string; scaledPrice: number; targetVolumeUsd: number }[] = [];

  // ── Phase 1: Direct resolution (stablecoin-target pools) ──────────────────
  for (const ticker of tickers) {
    if (!isStablecoin(ticker.target_currency)) continue;

    const baseSymbol   = tokenSymbol(ticker.base_currency);
    const targetSymbol = tokenSymbol(ticker.target_currency);
    const decimalsX    = getDecimalsForCurrency(ticker.base_currency);
    const decimalsY    = getDecimalsForCurrency(ticker.target_currency);
    const scaledPrice  = scaleBinPrice(parseFloat(ticker.last_price), decimalsX, decimalsY);

    // Stablecoin-quoted pools are interpreted against the tracked peg so stable
    // assets are benchmarked directly to $1. Non-tracked quotes can still fall
    // back to external market references.
    const targetUsd =
      FIXED_REFERENCE_PRICE_USD[targetSymbol] ?? externalPrices[targetSymbol] ?? null;
    const basePriceUsd = targetUsd != null ? scaledPrice * targetUsd : null;

    poolPrices.push({
      pool_id:       ticker.pool_id,
      ticker_id:     ticker.ticker_id,
      base_symbol:   baseSymbol,
      target_symbol: targetSymbol,
      scaled_price:  scaledPrice,
      base_price_usd: basePriceUsd,
      resolution:    basePriceUsd != null ? 'direct' : 'failed',
    });

    const targetVolumeUsd = parseFloat(ticker.target_volume) / Math.pow(10, decimalsY) * (targetUsd ?? 1);

    if (basePriceUsd != null) {
      // Volume in USD (target is a stablecoin)
      if (!vwapEntries[baseSymbol]) vwapEntries[baseSymbol] = [];
      vwapEntries[baseSymbol].push({ price: basePriceUsd, volumeUsd: targetVolumeUsd });
    }

    // Store for Phase 2.5 regardless of resolution success
    stablecoinPools.push({ baseSymbol, targetSymbol, scaledPrice, targetVolumeUsd });
  }

  // ── Phase 2: Cross-pair resolution (crypto-target pools) ──────────────────
  // Compute sBTC VWAP from Phase 1 results first (needed for STX/sBTC)
  const sbtcVwap = vwap(vwapEntries['sBTC'] ?? []);

  for (const ticker of tickers) {
    if (isStablecoin(ticker.target_currency)) continue;

    const baseSymbol   = tokenSymbol(ticker.base_currency);
    const targetSymbol = tokenSymbol(ticker.target_currency);
    const decimalsX    = getDecimalsForCurrency(ticker.base_currency);
    const decimalsY    = getDecimalsForCurrency(ticker.target_currency);
    const scaledPrice  = scaleBinPrice(parseFloat(ticker.last_price), decimalsX, decimalsY);

    let basePriceUsd: number | null = null;
    let resolution: PoolPriceUSD['resolution'] = 'failed';

    if (targetSymbol === 'sBTC' && sbtcVwap != null) {
      basePriceUsd = scaledPrice * sbtcVwap;
      resolution   = 'cross-pair';
    }
    // Future: additional cross-pair paths can be added here

    poolPrices.push({
      pool_id:       ticker.pool_id,
      ticker_id:     ticker.ticker_id,
      base_symbol:   baseSymbol,
      target_symbol: targetSymbol,
      scaled_price:  scaledPrice,
      base_price_usd: basePriceUsd,
      resolution,
    });

    if (basePriceUsd != null) {
      // Volume in USD (target is sBTC)
      const targetVolumeUsd = parseFloat(ticker.target_volume) / Math.pow(10, decimalsY) * (sbtcVwap ?? 0);
      if (!vwapEntries[baseSymbol]) vwapEntries[baseSymbol] = [];
      vwapEntries[baseSymbol].push({ price: basePriceUsd, volumeUsd: targetVolumeUsd });
    }
  }

  // ── Phase 2.5: Implied stablecoin prices ──────────────────────────────────
  // Use preliminary base-token VWAPs to back-derive stablecoin USD prices
  // implied_stablecoin_usd = base_vwap / scaled_price  (inversion of Phase 1)
  const impliedSymbols = new Set<string>();

  for (const pool of stablecoinPools) {
    const { baseSymbol, targetSymbol, scaledPrice, targetVolumeUsd } = pool;
    const baseVwap = vwap(vwapEntries[baseSymbol] ?? []);
    if (baseVwap == null || scaledPrice === 0) continue;
    const impliedPrice = baseVwap / scaledPrice;
    if (!vwapEntries[targetSymbol]) vwapEntries[targetSymbol] = [];
    vwapEntries[targetSymbol].push({ price: impliedPrice, volumeUsd: targetVolumeUsd });
    impliedSymbols.add(targetSymbol);
  }

  // ── Phase 3: VWAP aggregation ──────────────────────────────────────────────
  // Collect all unique symbols that appeared in any pool (base or target)
  const allSymbols = new Set<string>();
  for (const pp of poolPrices) {
    allSymbols.add(pp.base_symbol);
    allSymbols.add(pp.target_symbol);
  }

  const aggregated: AggregatedPrice[] = [];

  // Count failed pool resolutions for warnings
  const failedPoolCount = poolPrices.filter(pp => pp.resolution === 'failed').length;

  for (const symbol of allSymbols) {
    const entries  = vwapEntries[symbol] ?? [];
    const internal = vwap(entries);
    const fixedReference = FIXED_REFERENCE_PRICE_USD[symbol];
    const marketReference = externalPrices[symbol] ?? null;
    const reference = fixedReference ?? marketReference;
    const referenceSource: AggregatedPrice['reference_source'] =
      fixedReference != null ? 'fixed-peg' : 'coingecko';

    // ── Phase 4: Divergence calculation ──────────────────────────────────────
    let divergencePct: number | null = null;
    let isDivergent = false;
    if (internal != null && reference != null && reference !== 0) {
      divergencePct = ((internal - reference) / reference) * 100;
      const tolerance = TOLERANCE_PCT[symbol] ?? 2;
      isDivergent = Math.abs(divergencePct) > tolerance;
    }

    const poolCount      = entries.length;
    const totalVolumeUsd = entries.reduce((s, e) => s + e.volumeUsd, 0);

    // Determine resolution type
    let resolution: AggregatedPrice['resolution'];
    if (internal == null) {
      resolution = 'unavailable';
    } else if (impliedSymbols.has(symbol)) {
      resolution = 'implied';
    } else {
      resolution = 'vwap';
    }

    // Collect warnings
    const warnings: string[] = [];
    if (resolution === 'implied') {
      warnings.push('Price implied from DEX pairs, not direct trading');
    }
    if (resolution === 'unavailable') {
      warnings.push('No DEX trading data — needs active trading volume on pairs involving this token');
    }
    if (reference == null) {
      warnings.push('No reference price (CoinGecko unavailable)');
    }
    if (totalVolumeUsd === 0 && entries.length > 0) {
      warnings.push('No recent trading volume');
    }
    if (failedPoolCount > 0) {
      warnings.push(`Price resolution failed for ${failedPoolCount} pool(s) — external price unavailable for target stablecoin`);
    }
    if (isDivergent && divergencePct != null) {
      const tolerance = TOLERANCE_PCT[symbol] ?? 2;
      const referenceLabel =
        referenceSource === 'fixed-peg'
          ? 'fixed $1.00 peg'
          : 'CoinGecko reference';
      warnings.push(`Price diverges ${divergencePct >= 0 ? '+' : ''}${divergencePct.toFixed(4)}% from ${referenceLabel} (tolerance ±${tolerance}%)`);
    }

    aggregated.push({
      symbol,
      internal_price_usd: internal,
      reference_price_usd: reference,
      reference_source: referenceSource,
      external_price_usd: marketReference,
      divergence_pct:     divergencePct,
      tolerance_pct:      TOLERANCE_PCT[symbol] ?? 2,
      is_divergent:       isDivergent,
      pool_count:         poolCount,
      total_volume_usd:   totalVolumeUsd,
      resolution,
      warnings,
    });
  }

  // Sort aggregated for stable output: symbols with data first, then alphabetical
  aggregated.sort((a, b) => {
    const aHas = a.internal_price_usd != null ? 0 : 1;
    const bHas = b.internal_price_usd != null ? 0 : 1;
    return aHas - bHas || a.symbol.localeCompare(b.symbol);
  });

  return {
    timestamp:   new Date().toISOString(),
    pool_prices: poolPrices,
    aggregated,
  };
}
