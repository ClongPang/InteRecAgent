import { describe, expect, it } from "vitest";
import { Check } from "typebox/value";

import { turnPlanSchema } from "../src/schemas.js";

describe("model-facing turn plan schema", () => {
  it("accepts a bounded empty budget placeholder for deterministic Host removal", () => {
    expect(Check(turnPlanSchema, {
      userIntentSummary: "washing machine with no budget",
      ops: [
        {
          opId: "target",
          sourceMessageOrdinal: 0,
          kind: "GOAL_SET_TARGET",
          target: {
            categoryId: "washing_machine",
            canonicalModel: null,
            itemRole: "PRIMARY_PRODUCT",
            condition: "NEW",
          },
        },
        {
          opId: "empty-budget",
          sourceMessageOrdinal: 0,
          kind: "GOAL_SET_BUDGET",
          budget: { amount: "", currency: "" },
        },
      ],
      leftover: [],
    })).toBe(true);
  });
});
