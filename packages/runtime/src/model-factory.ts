import { createModels, type Model } from "@earendil-works/pi-ai";
import { deepseekProvider } from "@earendil-works/pi-ai/providers/deepseek";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";

import type { StreamFn } from "@earendil-works/pi-agent-core";

import { retailPriceEnvironmentValue } from "./environment.js";

export interface PiModelRuntime {
  model: Model<any>;
  streamFn: StreamFn;
  apiKey: string;
}

export function createPiModelRuntime(environment: NodeJS.ProcessEnv = process.env): PiModelRuntime {
  const providerId = retailPriceEnvironmentValue(environment, "MODEL_PROVIDER") ?? "deepseek";
  const modelId = retailPriceEnvironmentValue(environment, "MODEL_ID") ?? "deepseek-v4-flash";
  const apiKey = retailPriceEnvironmentValue(environment, "MODEL_API_KEY") ?? "";
  if (!apiKey) throw new Error("RETAIL_PRICE_MODEL_API_KEY_REQUIRED");
  const models = createModels();
  if (providerId === "deepseek") models.setProvider(deepseekProvider());
  else if (providerId === "openai") models.setProvider(openaiProvider());
  else throw new Error(`UNSUPPORTED_PI_PROVIDER:${providerId}`);
  const model = models.getModel(providerId, modelId);
  if (!model) throw new Error(`PI_MODEL_NOT_FOUND:${providerId}/${modelId}`);
  return { model, streamFn: models.streamSimple.bind(models), apiKey };
}
