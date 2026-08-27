const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LiveTurnConfig {
  turnId: string;
}

export function resolveLiveTurnConfig(environment: NodeJS.ProcessEnv = process.env): LiveTurnConfig {
  if (environment["INTEREC_LIVE_TURN_CONFIRM"] !== "authorized-external-turn") {
    throw new Error("INTEREC_LIVE_TURN_CONFIRM_MUST_BE_authorized-external-turn");
  }
  const turnId = environment["INTEREC_LIVE_TURN_ID"]?.trim() ?? "";
  if (!UUID_PATTERN.test(turnId)) throw new Error("INTEREC_LIVE_TURN_ID_MUST_BE_UUID");
  return { turnId };
}
