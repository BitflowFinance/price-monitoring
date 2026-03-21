# ticker-analytics

A Node.js/TypeScript cron job that fetches Bitflow ticker data every 30 minutes, persists it as a rolling time-series, reports price and volume variance across multiple lookback windows, and monitors for depeg events by comparing on-chain VWAP prices against reference benchmarks.

---

## How it works

```
┌─────────────────────────────────────────────────────────────────┐
│                        node-cron  (*/30 * * * *)                │
│                                                                 │
│   On startup ──────────────────────────────────────────────┐   │
│   Every 30min ─────────────────────────────────────────────┘   │
│                              │                                  │
│                              ▼                                  │
│                      [ runJob() ]                               │
│                              │                                  │
│         ┌────────────────────┼───────────────────┐             │
│         ▼                    ▼                   ▼             │
│   fetchTickers()   fetchExternalPrices()   loadSnapshots()      │
│         │                    │                   │             │
│         └──────────┬─────────┘                   │             │
│                    ▼                             │             │
│            computePricing()                      │             │
│            (VWAP + divergence)                   │             │
│                    │                             │             │
│            printPricingSummary()                 │             │
│                    │                             │             │
│                    └──────────────┬──────────────┘             │
│                                   ▼                            │
│                       for each interval                        │
│                       [30m, 2h, 6h, 12h, 24h]                  │
│                                   │                            │
│                                   ▼                            │
│                        findClosestSnapshot()                   │
│                                   │                            │
│                                   ▼                            │
│                    computeVariance() + computePricing(ref)     │
│                                   │                            │
│                                   ▼                            │
│                            printReport()                       │
│                                   │                            │
│                                   ▼                            │
│                             saveReport()                       │
│                                   │                            │
│                                   ▼                            │
│                            saveSnapshot()                      │
└─────────────────────────────────────────────────────────────────┘
```

---

## Depeg monitoring

The primary purpose of the pricing engine is to detect when any token's on-chain price diverges from its chosen reference benchmark. Each job run:

1. Computes a **VWAP USD price** for every token from Bitflow pool data (following CoinGecko's methodology: convert each pool's price to USD via the target currency, then weight by volume)
2. Fetches **market reference prices** from CoinGecko Pro API
3. Computes **divergence %** between internal and reference prices
4. Flags tokens that exceed their **tolerance threshold**

### Tolerance thresholds

| Token | Tolerance |
|-------|-----------|
| STX   | ±2%       |
| sBTC  | ±2%       |
| aeUSDC | ±0.1%   |
| USDCx  | ±0.1%   |
| USDh   | ±0.1%   |

### Price resolution strategy

**Direct** — pools where the target currency is a stablecoin (aeUSDC, USDCx, USDh):
```
base_price_usd = scaleBinPrice(last_price, decimalsX, decimalsY) × external_stablecoin_price
```

**Cross-pair** — pools where the target is a crypto (currently STX/sBTC):
```
stx_price_usd = scaleBinPrice(last_price, decimalsX, decimalsY) × sbtc_vwap_usd
```
sBTC's VWAP is established first from direct-resolution pools, then used as a bridge.

> Tracked stablecoins (`aeUSDC`, `USDCx`, `USDh`) are benchmarked against a fixed `$1.00` peg. Direct pool USD conversion through those quote assets also assumes the peg, which avoids circularly reusing CoinGecko prices that may themselves come from Bitflow.

---

## Variance intervals

Variance is computed by comparing the current fetch against the **snapshot closest in time** to each lookback target:

```
Timeline (each mark = one 30min snapshot)

  T-24h   T-12h    T-6h     T-2h  T-30m  NOW
    │        │        │        │      │    │
────●────────●────────●────────●──●──●────●────▶
    └────────┴────────┴────────┴──┴──┘
             compared intervals
```

| Interval | Snapshots back | Tolerance |
|----------|----------------|-----------|
| 30min    | 1              | ±10 min   |
| 2h       | 4              | ±10 min   |
| 6h       | 12             | ±10 min   |
| 12h      | 24             | ±10 min   |
| 24h      | 48             | ±10 min   |

> If no snapshot exists within the tolerance window, the interval is skipped silently. This handles cold starts and missed runs gracefully.

---

## Data flow

```
  ┌──────────────────────────────┐    ┌───────────────────────────────┐
  │   Bitflow BFF API            │    │   CoinGecko Pro API           │
  │   /api/app/v1/tickers        │    │   /api/v3/simple/price        │
  └──────────────┬───────────────┘    └───────────────┬───────────────┘
                 │  GET (15s timeout)                  │  GET (15s timeout)
                 ▼                                     ▼
          [ fetcher.ts ]                   [ external-prices.ts ]
                 │                                     │
      Ticker[]   │                  Record<symbol,USD> │
                 └───────────────┬─────────────────────┘
                                 ▼
                          [ pricing.ts ]
                          computePricing()
                                 │
                   PricingResult │  (pool_prices[], aggregated[])
                                 ▼
              ┌────────────────────────────────────┐
              │           [ index.ts ]             │
              │                                    │
              │  loadSnapshots() ◄── snapshots.json│
              │         │                          │
              │         ▼                          │
              │  findClosestSnapshot(ms) × 5       │
              │         │                          │
              │         ▼                          │
              │  computeVariance()                 │──► console output
              │  (with pricing for both snapshots) │
              │         │                          │
              │  saveReport()   ───► reports.json  │
              │         │                          │
              │  saveSnapshot() ──► snapshots.json │
              └────────────────────────────────────┘
```

---

## Storage model

Two flat JSON arrays are written under `data/`. Both are pruned on every write to keep only entries within a **25-hour rolling window**.

```
snapshots.json
┌─────────────────────────────────────────────────────────┐
│ [                                                       │
│   {                                                     │
│     "timestamp": "2026-03-13T00:00:00.000Z",  ◄── ISO  │
│     "tickers": [ ...Ticker[] ]                          │
│   },                                                    │
│   ...                                                   │
│   { "timestamp": "2026-03-14T00:30:00.000Z", ... }  ◄─ newest
│ ]                                                       │
│  Entries older than 25h are pruned on each save         │
└─────────────────────────────────────────────────────────┘

reports.json
┌─────────────────────────────────────────────────────────┐
│ [                                                       │
│   {                                                     │
│     "run_at":   "2026-03-13T00:30:00.000Z",  ◄── when  │
│     "interval": "30min",                               │
│     "snapshot_age_minutes": 30,                         │
│     "snapshot_timestamp": "2026-03-13T00:00:00.000Z",  │
│     "pools": [ ...PoolVariance[] ],                     │
│     "pricing": {                          ◄── new       │
│       "timestamp": "...",                               │
│       "pool_prices": [ ...PoolPriceUSD[] ],             │
│       "aggregated": [ ...AggregatedPrice[] ]            │
│     }                                                   │
│   },                                                    │
│   ...                                                   │
│ ]                                                       │
│  Entries older than 25h are pruned on each save         │
└─────────────────────────────────────────────────────────┘
```

### Snapshot lookup

```
snapshots:  ●────●────●────●────●────●────●   (every 30min)
                                             NOW
target:                    ◉                 (e.g. 2h ago)
                           │
                    find min |timestamp - target|
                           │
tolerance:         ◄──────◉──────►  ±10 min window
                           │
                      best match returned (or null)
```

---

## Type model

```
Ticker
┌──────────────────────────────────┐
│ ticker_id        string          │
│ pool_id          string  ◄── key │
│ base_currency    string          │
│ target_currency  string          │
│ last_price       string          │
│ base_volume      string          │
│ target_volume    string          │
│ liquidity_in_usd string          │
│ bid              string          │
│ ask              string          │
│ high             string          │
│ low              string          │
└──────────────────────────────────┘
         │ stored in
         ▼
Snapshot
┌──────────────────────────────────┐
│ timestamp   string (ISO 8601)    │
│ tickers     Ticker[]             │
└──────────────────────────────────┘
         │ compared to produce
         ▼
PoolVariance
┌──────────────────────────────────┐
│ pool_id         string           │
│ ticker_id       string           │
│ last_price      FieldVariance    │──┐
│ base_volume     FieldVariance    │  │
│ target_volume   FieldVariance    │  │
│ base_price_usd  FieldVariance?   │  │  ← USD price delta (new)
└──────────────────────────────────┘  │
                                      │
FieldVariance  ◄──────────────────────┘
┌──────────────────────────────────┐
│ current   number                 │
│ previous  number                 │
│ absolute  number  (curr - prev)  │
│ percent   number | null          │
│           null when previous = 0 │
└──────────────────────────────────┘
         │ grouped into
         ▼
IntervalReport
┌──────────────────────────────────┐
│ interval             string      │
│ snapshot_age_minutes number      │
│ snapshot_timestamp   string      │
│ pools                PoolVariance[] │
│ pricing              PricingResult? │  ← new
└──────────────────────────────────┘
         │ persisted as
         ▼
SavedReport  (extends IntervalReport)
┌──────────────────────────────────┐
│ run_at  string (ISO 8601)        │
│ ...all IntervalReport fields     │
└──────────────────────────────────┘

PricingResult                          ← new
┌──────────────────────────────────────────────┐
│ timestamp    string                          │
│ pool_prices  PoolPriceUSD[]                  │
│ aggregated   AggregatedPrice[]               │
└──────────────────────────────────────────────┘

PoolPriceUSD                           ← new
┌─────────────────────────────────────────────────────────┐
│ pool_id        string                                   │
│ ticker_id      string                                   │
│ base_symbol    string   ("STX", "sBTC", "aeUSDC", ...)  │
│ target_symbol  string   ("USDCx", "sBTC", ...)          │
│ scaled_price   number   scaleBinPrice result            │
│ base_price_usd number | null                            │
│ resolution     "direct" | "cross-pair" | "failed"       │
└─────────────────────────────────────────────────────────┘

AggregatedPrice                        ← new
┌─────────────────────────────────────────────────────────┐
│ symbol             string                               │
│ internal_price_usd number | null   VWAP from pools      │
│ reference_price_usd number | null  benchmark price      │
│ reference_source    string         coingecko/fixed-peg  │
│ divergence_pct     number | null   ((int-ref)/ref)×100  │
│ tolerance_pct      number                               │
│ is_divergent       boolean                              │
│ pool_count         number                               │
│ total_volume_usd   number                               │
└─────────────────────────────────────────────────────────┘
```

---

## Variance formula

```
  absolute = current − previous

             current − previous
  percent = ──────────────────── × 100
               |previous|

  (percent = null when previous = 0)
```

VWAP formula (used for internal USD prices):

```
             Σ (price_i × volume_usd_i)
  VWAP    = ──────────────────────────
                 Σ volume_usd_i

  (pools with zero volume are excluded from the weighted average)
```

---

## Module structure

```
src/
├── index.ts            Cron schedule, runJob() orchestration
├── fetcher.ts          HTTP fetch with 15s timeout
├── storage.ts          Load / save / prune snapshots and reports, findClosestSnapshot()
├── analyzer.ts         computeVariance(), printReport(), printPricingSummary()
├── pricing.ts          computePricing() — VWAP engine, cross-pair resolution, divergence
├── external-prices.ts  CoinGecko Pro API fetcher (COINGECKO_API_KEY env var)
├── tokens.ts           Token metadata, stablecoin classification, tolerance thresholds
├── utils.ts            scaleBinPrice(), getDecimalsForCurrency()
└── types.ts            All TypeScript interfaces
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `COINGECKO_API_KEY` | No | CoinGecko Pro API key. If unset, stablecoin peg checks still work, but CoinGecko-backed references for tokens like `STX` and `sBTC` will not be computed. |

---

## Sample output

```
================================================================================
  Job run at: 2026-03-13T15:00:00.000Z
================================================================================
[fetcher] Fetched 7 tickers.
[external-prices] Fetched 5 reference prices.

────────────────────────────────────────────────────────────────────────────────
  Aggregated USD Prices
────────────────────────────────────────────────────────────────────────────────
  STX      internal=$0.261432     reference=$0.262100    divergence=   -0.2550%
  sBTC     internal=$95123.420000 reference=$95000.000000 divergence=   +0.1299%
  aeUSDC   internal=$1.000120     reference=$1.000000    divergence=   +0.0120%
  USDCx    internal=$0.999980     reference=$1.000000    divergence=   -0.0020%
────────────────────────────────────────────────────────────────────────────────

────────────────────────────────────────────────────────────────────────────────
  Interval: 30min  |  Compared to snapshot from 30min ago
  Snapshot timestamp: 2026-03-13T14:30:00.000Z
────────────────────────────────────────────────────────────────────────────────

  Pool: dlmm_3  (SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.univ2-share-fee-to_...)
    last_price       prev=0.261000  curr=0.261432  delta=+0.000432  (+0.1655%)
    base_volume      prev=1234567   curr=1289012   delta=+54445      (+4.4100%)
    target_volume    prev=322.410   curr=336.620   delta=+14.210     (+4.4100%)
    base_price_usd   prev=$0.261000 curr=$0.261432 delta=+$0.000432  (+0.1655%)

────────────────────────────────────────────────────────────────────────────────

[storage] Saved snapshot at 2026-03-13T15:00:00.000Z. Total kept: 3
```

---

## Getting started

```bash
nvm use
npm install
cp .env.example .env
# set COINGECKO_API_KEY in .env (optional but recommended)
npm start
```

Notes:

- The repo includes `.nvmrc` and is tested with Node `18.20.8`.
- `npm start` and `npm run dev` automatically load `.env` via `dotenv`.
- `.env` is ignored by Git.
- The job runs immediately on startup, then every 30 minutes via cron.
- Data is written to `data/snapshots.json` and `data/reports.json` (both created automatically).

---

## Dashboard

A single-file analytics dashboard is included at `dashboard.html`. It reads `data/snapshots.json` and `data/reports.json` via `fetch()` and must be served over HTTP (not opened as a local file).

```bash
npm run dashboard
# open http://localhost:5000/dashboard.html
```

`npm run dashboard` uses the local `serve` dependency installed by `npm install`, so it does not rely on a one-off `npx` download.

### Token Price Bar (always visible)

A row of cards at the top of every view, one per token (STX, sBTC, aeUSDC, USDCx, USDh), showing:

- VWAP internal USD price
- Reference price
- Divergence % — green (within tolerance), orange (>50% of tolerance), red (divergent, ⚠)

Cards with active divergence get a red border. Click any card to open the **Token VWAP History** view.

### Pool Grid (home view)

Pool cards in a responsive grid, each showing:

- Pool ID and token pair (e.g. STX/USDCx)
- Current price, liquidity in USD, and base token USD price
- 30-minute price Δ% and volume Δ% badges (green / red / gray)
- Mini sparkline of the full price history

Click any card to drill into the detail view.

### Pool Detail view

| Section | Contents |
|---------|----------|
| Header | Pool ID, pair name, current price, last updated |
| Variance table | Rows for each interval (30min / 2h / 6h / 12h / 24h), columns for price Δ%, **USD price Δ%**, base volume Δ%, target volume Δ% — colored by magnitude |
| Price history | Line chart across all stored snapshots |
| USD Price history | Line chart of base token USD price over time, with the token reference as a dashed line |
| Volume history | Line chart with base volume and target volume as separate datasets |
| Activity log | All report entries for the pool, newest first, formatted like the console output |

### Token VWAP History view

Opened by clicking a token card in the price bar. Shows:

- VWAP internal price over time (line chart)
- Latest reference price as a flat dashed line
- Current divergence % and tolerance in the header

The back button returns to the grid. All views auto-refresh every 60 seconds (countdown shown in the header).

### Requirements

- Node.js 18+ (`nvm use` will use the pinned version from `.nvmrc`)

---

## Cron expression

```
*/30 * * * *
  │   │ │ │ └─ every day of week
  │   │ │ └─── every month
  │   │ └───── every day of month
  │   └─────── every hour
  └─────────── every 30 minutes  (0 and 30)
```
