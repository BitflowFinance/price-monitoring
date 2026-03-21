import "dotenv/config";
import cron from "node-cron";
import { fetchTickers } from "./fetcher.js";
import { loadSnapshots, saveSnapshot, findClosestSnapshot, saveReport } from "./storage.js";
import { computeVariance, printReport, printPricingSummary } from "./analyzer.js";
import { fetchExternalPrices } from "./external-prices.js";
import { computePricing } from "./pricing.js";

// Lookback windows in milliseconds
const INTERVALS: { label: string; ms: number }[] = [
  { label: "30min", ms: 30 * 60 * 1000 },
  { label: "2h",    ms:  2 * 60 * 60 * 1000 },
  { label: "6h",    ms:  6 * 60 * 60 * 1000 },
  { label: "12h",   ms: 12 * 60 * 60 * 1000 },
  { label: "24h",   ms: 24 * 60 * 60 * 1000 },
];

async function runJob(): Promise<void> {
  const runAt = new Date().toISOString();
  console.log(`\n${"=".repeat(80)}`);
  console.log(`  Job run at: ${runAt}`);
  console.log("=".repeat(80));

  let tickers;
  try {
    tickers = await fetchTickers();
    console.log(`[fetcher] Fetched ${tickers.length} tickers.`);
  } catch (err) {
    console.error("[fetcher] Failed to fetch tickers:", err);
    return;
  }

  // Fetch external reference prices once, shared across all intervals
  const externalPrices = await fetchExternalPrices();
  const externalCount = Object.keys(externalPrices).length;
  if (externalCount > 0) {
    console.log(`[external-prices] Fetched ${externalCount} reference prices.`);
  }

  // Compute current pricing (VWAP + divergence)
  const currentPricing = computePricing(tickers, externalPrices);

  // Log aggregated prices to console
  const dummyReport = { interval: 'current', snapshot_age_minutes: 0, snapshot_timestamp: runAt, pools: [], pricing: currentPricing };
  printPricingSummary(dummyReport);

  // Load existing snapshots BEFORE saving the new one (so we compare against past data)
  const snapshots = loadSnapshots();

  // Run variance reports for each interval.
  // pricing is only attached to the first interval report per run to avoid
  // storing 5 duplicate copies of the same PricingResult in reports.json.
  let pricingSaved = false;
  for (const { label, ms } of INTERVALS) {
    const ref = findClosestSnapshot(snapshots, ms);
    if (!ref) {
      console.log(`[analyzer] No snapshot available for ${label} interval yet.`);
      continue;
    }
    const refPricing = computePricing(ref.tickers, externalPrices);
    const report = computeVariance(tickers, ref, label, currentPricing, refPricing);
    printReport(report);
    if (!pricingSaved) {
      saveReport(report, runAt);
      pricingSaved = true;
    } else {
      saveReport({ ...report, pricing: undefined }, runAt);
    }
  }

  // Persist current snapshot after analysis
  saveSnapshot(tickers);
}

// Run immediately on startup, then every 30 minutes
console.log("[cron] Ticker analytics starting...");
runJob();

cron.schedule("*/30 * * * *", () => {
  runJob().catch((err) => console.error("[cron] Unhandled error in job:", err));
});
