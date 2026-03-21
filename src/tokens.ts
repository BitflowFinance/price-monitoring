// Contract names for stablecoins (the suffix after the dot in a full contract ID)
export const STABLECOIN_CONTRACTS = new Set([
  "usdcx",
  "token-aeusdc",
  "usdh-token-v1",
]);

export function isStablecoin(currency: string): boolean {
  const contractName = currency.includes(".")
    ? currency.split(".").pop()!
    : currency;
  return STABLECOIN_CONTRACTS.has(contractName);
}

// Maps contract-name → human-readable symbol
export const CONTRACT_TO_SYMBOL: Record<string, string> = {
  "token-stx-v-1-2": "STX",
  "sbtc-token": "sBTC",
  "token-aeusdc": "aeUSDC",
  usdcx: "USDCx",
  "usdh-token-v1": "USDh",
};

export function tokenSymbol(currency: string): string {
  if (currency in CONTRACT_TO_SYMBOL) return CONTRACT_TO_SYMBOL[currency];
  const contractName = currency.includes(".")
    ? currency.split(".").pop()!
    : currency;
  return CONTRACT_TO_SYMBOL[contractName] ?? contractName;
}

// Divergence tolerance thresholds (%)
export const TOLERANCE_PCT: Record<string, number> = {
  STX: 2,
  sBTC: 2,
  aeUSDC: 0.1,
  USDCx: 0.1,
  USDh: 0.1,
};

// Tokens whose divergence should be measured against a fixed peg instead of
// an external market feed.
export const FIXED_REFERENCE_PRICE_USD: Record<string, number> = {
  aeUSDC: 1,
  USDCx: 1,
  USDh: 1,
};

// CoinGecko API IDs for external price lookup
export const COINGECKO_IDS: Record<string, string> = {
  STX: "blockstack",
  sBTC: "bitcoin",
  aeUSDC: "allbridge-bridged-usdc-stacks",
  USDCx: "usdcx-stacks",
  USDh: "hermetica-usdh",
};

export const TOKENS = {
  STX: {
    decimals: 6,
  },
  sBTC: {
    decimals: 8,
  },
  aeUSDC: {
    decimals: 6,
  },
  USDCx: {
    decimals: 6,
  },
  USDh: {
    decimals: 8,
  },
};

// Maps the contract-name portion of a currency identifier (e.g. the "usdcx" in
// "SP123.usdcx") to its decimal precision. Used when base_currency /
// target_currency are full contract addresses rather than short token symbols.
export const TOKEN_CONTRACTS: Record<string, number> = {
  "token-stx-v-1-2": 6, // STX
  "sbtc-token": 8, // sBTC
  "token-aeusdc": 6, // aeUSDC
  usdcx: 6, // USDCx
  "usdh-token-v1": 8, // USDh
};
