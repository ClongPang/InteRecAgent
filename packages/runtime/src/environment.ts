const PRIMARY_PREFIX = "RETAIL_PRICE_";
const LEGACY_PREFIX = "INTEREC_";

/** Reads the current environment name first and preserves the pre-rename alias. */
export function retailPriceEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  suffix: string,
): string | undefined {
  return environment[`${PRIMARY_PREFIX}${suffix}`] ?? environment[`${LEGACY_PREFIX}${suffix}`];
}

export function requiredRetailPriceEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  suffix: string,
): string {
  const value = retailPriceEnvironmentValue(environment, suffix)?.trim();
  if (!value) throw new Error(`${PRIMARY_PREFIX}${suffix}_REQUIRED`);
  return value;
}
