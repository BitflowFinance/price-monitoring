import { Ticker, Snapshot, FieldVariance, PoolVariance, IntervalReport, PricingResult } from "./types.js";
import { scaleBinPrice, getDecimalsForCurrency } from "./utils.js";

function fieldVariance(current: number, previous: number): FieldVariance {
  const absolute = current - previous;
  const percent = previous !== 0 ? (absolute / Math.abs(previous)) * 100 : null;
  return { current, previous, absolute, percent };
}

function buildPoolMap(tickers: Ticker[]): Map<string, Ticker> {
  return new Map(tickers.map((t) => [t.pool_id, t]));
}

export function computeVariance(
  current: Ticker[],
  previous: Snapshot,
  intervalLabel: string,
  currentPricing?: PricingResult,
  previousPricing?: PricingResult,
): IntervalReport {
  const prevMap = buildPoolMap(previous.tickers);
  const snapshotAgeMs = Date.now() - new Date(previous.timestamp).getTime();
  const snapshotAgeMinutes = Math.round(snapshotAgeMs / 60_000);

  // Build a quick lookup for USD prices by pool_id
  const currUsdByPool = new Map(
    (currentPricing?.pool_prices ?? []).map(p => [p.pool_id, p.base_price_usd])
  );
  const prevUsdByPool = new Map(
    (previousPricing?.pool_prices ?? []).map(p => [p.pool_id, p.base_price_usd])
  );

  const pools: PoolVariance[] = [];

  for (const curr of current) {
    const prev = prevMap.get(curr.pool_id);
    if (!prev) continue; // pool not in previous snapshot, skip

    const decimalsX = getDecimalsForCurrency(curr.base_currency);
    const decimalsY = getDecimalsForCurrency(curr.target_currency);

    const currUsd = currUsdByPool.get(curr.pool_id) ?? null;
    const prevUsd = prevUsdByPool.get(curr.pool_id) ?? null;

    pools.push({
      pool_id: curr.pool_id,
      ticker_id: curr.ticker_id,
      last_price: fieldVariance(
        scaleBinPrice(parseFloat(curr.last_price), decimalsX, decimalsY),
        scaleBinPrice(parseFloat(prev.last_price), decimalsX, decimalsY)
      ),
      base_volume: fieldVariance(
        parseFloat(curr.base_volume),
        parseFloat(prev.base_volume)
      ),
      target_volume: fieldVariance(
        parseFloat(curr.target_volume),
        parseFloat(prev.target_volume)
      ),
      base_price_usd: (currUsd != null && prevUsd != null)
        ? fieldVariance(currUsd, prevUsd)
        : null,
    });
  }

  return {
    interval: intervalLabel,
    snapshot_age_minutes: snapshotAgeMinutes,
    snapshot_timestamp: previous.timestamp,
    pools,
    pricing: currentPricing,
  };
}

function fmt(v: FieldVariance, label: string): string {
  const pct =
    v.percent === null
      ? "n/a (prev=0)"
      : `${v.percent >= 0 ? "+" : ""}${v.percent.toFixed(4)}%`;
  const abs = `${v.absolute >= 0 ? "+" : ""}${v.absolute.toFixed(6)}`;
  return `    ${label.padEnd(16)} prev=${v.previous.toFixed(6)}  curr=${v.current.toFixed(6)}  delta=${abs}  (${pct})`;
}

export function printReport(report: IntervalReport): void {
  const divider = "─".repeat(80);
  console.log(`\n${divider}`);
  console.log(
    `  Interval: ${report.interval}  |  Compared to snapshot from ${report.snapshot_age_minutes}min ago`
  );
  console.log(`  Snapshot timestamp: ${report.snapshot_timestamp}`);
  console.log(divider);

  if (report.pools.length === 0) {
    console.log("  No matching pools found.");
    return;
  }

  for (const pool of report.pools) {
    // Only print pools where at least one field changed
    const anyChange =
      pool.last_price.absolute !== 0 ||
      pool.base_volume.absolute !== 0 ||
      pool.target_volume.absolute !== 0;

    if (!anyChange) continue;

    console.log(`\n  Pool: ${pool.pool_id}  (${pool.ticker_id})`);
    console.log(fmt(pool.last_price, "last_price"));
    console.log(fmt(pool.base_volume, "base_volume"));
    console.log(fmt(pool.target_volume, "target_volume"));
    if (pool.base_price_usd) {
      console.log(fmt(pool.base_price_usd, "base_price_usd"));
    }
  }

  console.log(`\n${divider}\n`);
}

export function printPricingSummary(report: IntervalReport): void {
  if (!report.pricing) return;
  const divider = "─".repeat(80);
  console.log(`\n${divider}`);
  console.log("  Aggregated USD Prices");
  console.log(divider);
  for (const agg of report.pricing.aggregated) {
    if (agg.internal_price_usd == null) continue;
    const internal = `$${agg.internal_price_usd.toFixed(6)}`;
    const reference = agg.reference_price_usd != null ? `$${agg.reference_price_usd.toFixed(6)}` : "n/a";
    const divPct   = agg.divergence_pct != null
      ? `${agg.divergence_pct >= 0 ? "+" : ""}${agg.divergence_pct.toFixed(4)}%`
      : "n/a";
    const flag     = agg.is_divergent ? " ⚠ DIVERGENT" : "";
    console.log(
      `  ${agg.symbol.padEnd(8)} internal=${internal.padEnd(14)} reference=${reference.padEnd(14)} divergence=${divPct.padStart(10)}${flag}`
    );
  }
  console.log(`${divider}\n`);
}
