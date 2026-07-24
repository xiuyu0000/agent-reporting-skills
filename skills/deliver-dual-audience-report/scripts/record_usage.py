#!/usr/bin/env python3
"""Append a content-free local usage receipt for an installed workflow Skill."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import secrets
import time
from datetime import datetime, timezone
from pathlib import Path


ALLOWED_ARTIFACTS = {"audit-codex-session-history", "deliver-dual-audience-report"}


def parse_tristate(value: str) -> bool | None:
    return {"yes": True, "no": False, "unknown": None}[value]


def tree_hash(root: Path) -> str:
    rows = []
    for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file()):
        relative = path.relative_to(root).as_posix()
        if "__pycache__" in relative or relative.endswith(".pyc"):
            continue
        rows.append((relative, hashlib.sha256(path.read_bytes()).hexdigest()))
    return hashlib.sha256(json.dumps(rows, separators=(",", ":")).encode()).hexdigest()


def load_key(state_dir: Path) -> bytes:
    path = state_dir / "receipt-hmac.key"
    state_dir.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path.read_bytes()
    key = secrets.token_bytes(32)
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path.read_bytes()
    with os.fdopen(descriptor, "wb") as handle:
        handle.write(key)
    return key


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-id", choices=sorted(ALLOWED_ARTIFACTS))
    parser.add_argument("--state-dir", type=Path, default=Path.home() / ".codex/evals/agent-workflow-evals")
    parser.add_argument("--scenario-key", help="Optional redacted stable task key; never pass dialogue, paths, or Session IDs.")
    parser.add_argument("--eligible", choices=("yes", "no", "unknown"), default="unknown")
    parser.add_argument("--triggered", choices=("yes", "no"), required=True)
    parser.add_argument("--correct", choices=("yes", "no", "unknown"), default="unknown")
    parser.add_argument("--validation", choices=("passed", "failed", "not-run", "unknown"), required=True)
    parser.add_argument("--result", choices=("success", "failure", "blocked", "unknown"), required=True)
    parser.add_argument("--corrections", type=int, default=0)
    parser.add_argument("--interruptions", type=int, default=0)
    parser.add_argument("--review-minutes", type=float, default=0)
    args = parser.parse_args()
    if min(args.corrections, args.interruptions, args.review_minutes) < 0:
        parser.error("human burden values must be non-negative")

    skill_root = Path(__file__).resolve().parents[1]
    artifact_id = args.artifact_id or skill_root.name
    if artifact_id not in ALLOWED_ARTIFACTS:
        parser.error("artifact id is not an approved v1 Skill")
    state_dir = args.state_dir.expanduser().resolve()
    key = load_key(state_dir)
    occurred_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
    scenario_seed = args.scenario_key or f"unattributed:{time.time_ns()}"
    scenario_id = "SC-" + hmac.new(key, scenario_seed.encode(), hashlib.sha256).hexdigest()[:16].upper()
    aliases_path = state_dir / "deployment-aliases.json"
    aliases = json.loads(aliases_path.read_text(encoding="utf-8")) if aliases_path.exists() else {}
    content_hash = tree_hash(skill_root)
    identity = hashlib.sha256(
        f"{artifact_id}\0{content_hash}\0{scenario_id}\0{occurred_at}\0{time.time_ns()}".encode()
    ).hexdigest()[:16].upper()
    receipt = {
        "schema_version": 1,
        "receipt_id": f"UR-{identity}",
        "artifact_id": artifact_id,
        "artifact_content_hash": content_hash,
        "deployment_id": aliases.get(artifact_id),
        "occurred_at": occurred_at,
        "scenario_id": scenario_id,
        "trigger": {
            "eligible": parse_tristate(args.eligible),
            "triggered": parse_tristate(args.triggered),
            "correct": parse_tristate(args.correct),
        },
        "validation": args.validation,
        "terminal": args.result,
        "human": {
            "corrections": args.corrections,
            "interruptions": args.interruptions,
            "review_minutes": args.review_minutes,
        },
        "privacy": {
            "contains_dialogue": False,
            "contains_commands": False,
            "contains_outputs": False,
            "contains_paths": False,
            "contains_session_ids": False,
        },
    }
    destination = state_dir / "usage-receipts" / f"{artifact_id}.jsonl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("a", encoding="utf-8") as handle:
        os.chmod(destination, 0o600)
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        handle.write(json.dumps(receipt, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    print(json.dumps({"status": "recorded", "receipt_id": receipt["receipt_id"], "artifact_id": artifact_id}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
