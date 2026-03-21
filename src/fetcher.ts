import { Ticker } from "./types.js";

const TICKERS_URL = "https://bff.bitflowapis.finance/api/app/v1/tickers";

export async function fetchTickers(): Promise<Ticker[]> {
  const response = await fetch(TICKERS_URL, {
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

  return data as Ticker[];
}
