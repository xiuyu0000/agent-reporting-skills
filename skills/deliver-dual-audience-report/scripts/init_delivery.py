#!/usr/bin/env python3
"""Initialize a dual-audience report contract and both artifact skeletons."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime
from pathlib import Path


SCHEMA_VERSION = "dual-audience-report-contract-v1"
SAFE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


def iso_timestamp(value: str) -> str:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--as-of must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise argparse.ArgumentTypeError("--as-of must include a timezone")
    return value


def safe_filename(value: str, suffix: str) -> str:
    if not SAFE_NAME.fullmatch(value) or Path(value).name != value:
        raise ValueError(f"unsafe filename: {value!r}")
    if not value.lower().endswith(suffix):
        raise ValueError(f"filename must end with {suffix}: {value!r}")
    return value


def render(template: str, replacements: dict[str, str]) -> str:
    for key, value in replacements.items():
        template = template.replace("{{" + key + "}}", value)
    return template


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--base-name", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--language", required=True)
    parser.add_argument("--as-of", type=iso_timestamp, required=True)
    parser.add_argument("--agent-name")
    parser.add_argument("--human-name")
    parser.add_argument(
        "--repository-status",
        choices=("local-only", "tracked-approved", "public-approved"),
        default="local-only",
    )
    args = parser.parse_args()

    if not SAFE_NAME.fullmatch(args.base_name) or "." in args.base_name:
        parser.error("--base-name must contain only letters, numbers, dot-free hyphens, or underscores")
    agent_name = args.agent_name or f"{args.base_name}_AGENT.md"
    human_name = args.human_name or f"{args.base_name}_HUMAN.html"
    try:
        safe_filename(agent_name, ".md")
        safe_filename(human_name, ".html")
    except ValueError as exc:
        parser.error(str(exc))

    output_dir = args.output_dir.expanduser().resolve()
    contract_path = output_dir / "report-contract.json"
    targets = (contract_path, output_dir / agent_name, output_dir / human_name)
    existing = [str(path) for path in targets if path.exists()]
    if existing:
        print("Refusing to overwrite existing delivery files:", file=sys.stderr)
        for path in existing:
            print(f"- {path}", file=sys.stderr)
        return 2

    output_dir.mkdir(parents=True, exist_ok=True)
    report_id = "DAR-" + hashlib.sha256(
        f"{args.base_name}\0{args.title}\0{args.as_of}".encode("utf-8")
    ).hexdigest()[:12].upper()
    contract = {
        "schema_version": SCHEMA_VERSION,
        "report_id": report_id,
        "title": args.title,
        "language": args.language,
        "as_of": args.as_of,
        "output_dir": ".",
        "repository_status": args.repository_status,
        "source_hierarchy": [
            {
                "rank": 1,
                "label": "{{REPLACE_SOURCE_LABEL}}",
                "reference": "{{REPLACE_SOURCE_REFERENCE}}",
                "freshness": "snapshot",
            }
        ],
        "deliverables": {
            "agent": {
                "path": agent_name,
                "format": "markdown",
                "audience": "agent",
                "status": "skeleton",
                "required": True,
                "waiver_reason": None,
            },
            "human": {
                "path": human_name,
                "format": "html",
                "audience": "human",
                "status": "skeleton",
                "required": True,
                "waiver_reason": None,
            },
        },
        "claims": [],
        "decisions": [],
        "constraints": ["{{REPLACE_CONSTRAINTS}}"],
        "risks": ["{{REPLACE_RISKS}}"],
        "open_questions": ["{{REPLACE_OPEN_QUESTIONS_OR_NONE}}"],
        "validation": {
            "status": "pending",
            "agent_sha256": None,
            "human_sha256": None,
        },
    }

    skill_dir = Path(__file__).resolve().parents[1]
    agent_template = (skill_dir / "assets/agent-report.template.md").read_text(encoding="utf-8")
    human_template = (skill_dir / "assets/human-report.template.html").read_text(encoding="utf-8")
    replacements = {
        "REPORT_ID": report_id,
        "AS_OF": args.as_of,
        "TITLE": args.title,
        "LANGUAGE": args.language,
    }
    (output_dir / agent_name).write_text(render(agent_template, replacements), encoding="utf-8")
    (output_dir / human_name).write_text(render(human_template, replacements), encoding="utf-8")
    contract_path.write_text(json.dumps(contract, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    print(json.dumps({
        "contract": str(contract_path),
        "agent": str(output_dir / agent_name),
        "human": str(output_dir / human_name),
        "report_id": report_id,
    }, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
