import { Decimal } from "decimal.js";

import { DomainError } from "./errors.js";
import type { FxSnapshot, Money } from "./quote-base-types.js";

Decimal.set({ precision: 32, rounding: Decimal.ROUND_HALF_UP });

export function canonicalDecimal(value: string): string {
  let decimal: Decimal;
  try {
    decimal = new Decimal(value);
  } catch {
    throw new DomainError("INVALID_DECIMAL", `Invalid decimal: ${value}`);
  }
  if (!decimal.isFinite()) {
    throw new DomainError("INVALID_DECIMAL", `Non-finite decimal: ${value}`);
  }
  return decimal.toFixed();
}

export function convertToCny(money: Money, fx: FxSnapshot): string {
  if (money.currency.toUpperCase() !== fx.base.toUpperCase() || fx.quote !== "CNY") {
    throw new DomainError("FX_PAIR_MISMATCH", "FX snapshot does not match the money pair");
  }
  const amount = new Decimal(canonicalDecimal(money.amount));
  const rate = new Decimal(canonicalDecimal(fx.rate));
  if (amount.lte(0) || rate.lte(0)) {
    throw new DomainError("NON_POSITIVE_MONEY", "Money and FX rate must be positive");
  }
  return amount.mul(rate).toDecimalPlaces(2).toFixed(2);
}

export function compareDecimal(left: string, right: string): number {
  return new Decimal(canonicalDecimal(left)).comparedTo(new Decimal(canonicalDecimal(right)));
}
