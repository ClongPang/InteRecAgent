export type ProductCondition = "NEW" | "USED" | "REFURBISHED" | "UNKNOWN";

export interface Money {
  amount: string;
  currency: string;
}

export interface FxSnapshot {
  id: string;
  base: string;
  quote: "CNY";
  rate: string;
  provider: string;
  observedAt: string;
  expiresAt: string;
}
