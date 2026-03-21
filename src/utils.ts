import { TOKENS, TOKEN_CONTRACTS } from "./tokens.js";

export const DEFAULT_POOL_PRICE_SCALE_BPS = 1e8;

/**
 * Resolve the decimal precision for a currency string.
 * Accepts either a short symbol ("STX", "sBTC") or a full contract identifier
 * ("SP123.usdcx"). Falls back to 6 if unknown.
 */
export const getDecimalsForCurrency = (currency: string): number => {
  if (currency in TOKENS) {
    return TOKENS[currency as keyof typeof TOKENS].decimals;
  }
  const contractName = currency.includes(".")
    ? currency.split(".").pop()!
    : currency;
  return TOKEN_CONTRACTS[contractName] ?? 6;
};

export const scaleBinPrice = (
  price: number,
  decimalsX: number,
  decimalsY: number,
  invert = false
) => {
  const actualPrice =
    (Number(price) * 10 ** (decimalsX - decimalsY)) /
    DEFAULT_POOL_PRICE_SCALE_BPS;

  return invert ? 1 / actualPrice : actualPrice;
};

export const unscaleBinPrice = (
  actualPrice: number,
  decimalsX: number,
  decimalsY: number,
  invert = false
) => {
  const normalizedPrice = invert
    ? 1 / Number(actualPrice)
    : Number(actualPrice);

  return (
    (normalizedPrice * DEFAULT_POOL_PRICE_SCALE_BPS) /
    10 ** (decimalsX - decimalsY)
  );
};
