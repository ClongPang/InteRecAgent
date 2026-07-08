from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


TASK_TEMPLATES: dict[str, list[dict[str, Any]]] = {
    "single_item_recommendation": [
        {
            "message": "Recommend wireless headphones under {budget} dollars for commuting.",
            "expected_intent": {"category": "wireless headphones", "budget.max": "{budget}", "goal": "commuting"},
        },
        {
            "message": "Recommend a quiet office mouse under {budget} dollars.",
            "expected_intent": {"category": "wireless mouse", "budget.max": "{budget}", "goal": "work"},
        },
        {
            "message": "I need comfortable wireless headphones for daily commuting.",
            "expected_intent": {"category": "wireless headphones", "goal": "commuting"},
        },
    ],
    "negative_feedback": [
        {"message": "Too expensive", "feedback_type": "price"},
        {"message": "Avoid this brand", "feedback_type": "brand"},
        {"message": "I don't want this brand", "feedback_type": "brand"},
    ],
    "alternative_recommendation": [
        {"message": "Show me a cheaper alternative."},
        {"message": "Show me another one similar to this."},
        {"message": "Is there a more portable alternative?"},
    ],
    "comparison": [
        {"message": "Compare these headphones for commuting."},
        {"message": "Compare quiet office mice under {budget} dollars."},
        {"message": "Can you compare the top options?"},
    ],
    "gift_recommendation": [
        {"message": "Recommend a gift for someone who commutes daily."},
        {"message": "Find a gift under {budget} dollars for an office worker."},
        {"message": "I need a gift recommendation for a student."},
    ],
    "bundle_recommendation": [
        {"message": "Recommend a starter kit bundle for a home office."},
        {"message": "Build a bundle under {budget} dollars for commuting."},
        {"message": "Suggest a set of accessories for work."},
    ],
    "unsupported": [
        {"message": "Can you buy it and check shipping?"},
        {"message": "Is this in stock today?"},
        {"message": "Please complete checkout and payment."},
    ],
}


def generate_task_cases(target_count: int = 140) -> list[dict[str, Any]]:
    if target_count < len(TASK_TEMPLATES):
        raise ValueError("target_count must cover every task label")
    labels = list(TASK_TEMPLATES)
    budgets = [50, 75, 100, 125, 150]
    cases: list[dict[str, Any]] = []
    index = 0
    while len(cases) < target_count:
        label = labels[index % len(labels)]
        templates = TASK_TEMPLATES[label]
        template = templates[(index // len(labels)) % len(templates)]
        budget = budgets[index % len(budgets)]
        case = {
            "case_id": f"task_{label}_{len(cases) + 1:03d}",
            "message": template["message"].format(budget=budget),
            "expected_task_type": label,
        }
        expected_intent = template.get("expected_intent")
        if expected_intent:
            case["expected_intent"] = {
                key: (float(budget) if value == "{budget}" else value)
                for key, value in expected_intent.items()
            }
        if "feedback_type" in template:
            case["feedback_type"] = template["feedback_type"]
            case["anchor_product_id"] = "prod_headphones_001"
        cases.append(case)
        index += 1
    return cases


def write_task_cases(path: Path, target_count: int = 140) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as output:
        for case in generate_task_cases(target_count):
            output.write(json.dumps(case, sort_keys=True))
            output.write("\n")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate deterministic InteRecAgent task cases.")
    parser.add_argument("--output", type=Path, default=Path("data/eval/task_cases.jsonl"))
    parser.add_argument("--count", type=int, default=140)
    args = parser.parse_args()
    write_task_cases(args.output, args.count)
    print(json.dumps({"output": str(args.output), "count": args.count}, sort_keys=True))


if __name__ == "__main__":
    main()
