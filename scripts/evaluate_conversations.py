from __future__ import annotations

import argparse
import json
from pathlib import Path

from backend.application.services.evaluation import (
    ConversationObservation,
    evaluate_conversations,
)


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate multi-user shopping traces")
    parser.add_argument("input", type=Path, help="JSON list of ConversationObservation objects")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    observations = [
        ConversationObservation.model_validate(item)
        for item in json.loads(args.input.read_text(encoding="utf-8"))
    ]
    report = evaluate_conversations(observations).model_dump(mode="json")
    rendered = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        args.output.write_text(rendered, encoding="utf-8")
    print(rendered)


if __name__ == "__main__":
    main()
