#!/usr/bin/env python3
"""Validate both report artifacts and emit a deterministic delivery receipt."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


PLACEHOLDER = re.compile(r"(?i)(?:\{\{[^}]+\}\}|\bTODO\b|\bTBD\b|REPLACE_[A-Z0-9_]+|待填写|待补充)")
SECRET = re.compile(
    r"(?i)(?:authorization\s*[:=]\s*\S+|bearer\s+[a-z0-9._-]{12,}|"
    r"sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{20,}|"
    r"api[_-]?key\s*[:=]\s*\S+|password\s*[:=]\s*\S+)"
)
PRIVATE_PATH = re.compile(r"(?i)(?:/Users/[^/\s<]+|/home/[^/\s<]+|[A-Z]:\\Users\\[^\\\s<]+|file://)")
SESSION_ID = re.compile(r"(?i)session[ _-]?id\s*[:=]\s*[0-9a-f]{8}-[0-9a-f-]{20,}")
MARKER = re.compile(r"(?m)\b(claim|decision):([CD]-\d{3}):([a-f0-9]{64})\b")
MD_LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")
ALLOWED_TOP = {
    "schema_version", "report_id", "title", "language", "as_of", "output_dir",
    "repository_status", "source_hierarchy", "deliverables", "claims", "decisions",
    "constraints", "risks", "open_questions", "validation",
}


class ReportHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: list[str] = []
        self.anchors: list[str] = []
        self.metas: dict[str, str] = {}
        self.markers: dict[tuple[str, str], str] = {}
        self.external_resources: list[str] = []
        self.has_main = False
        self.has_skip = False
        self.has_nav_label = False
        self.has_viewport = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.lower(): value or "" for key, value in attrs}
        if values.get("id"):
            self.ids.append(values["id"])
        href = values.get("href", "")
        if tag == "a" and href.startswith("#"):
            self.anchors.append(href[1:])
            if href == "#main" and "skip" in values.get("class", "").lower():
                self.has_skip = True
        if tag == "meta":
            name = values.get("name", "")
            if name:
                self.metas[name] = values.get("content", "")
            if name == "viewport":
                self.has_viewport = True
        if tag == "main":
            self.has_main = True
        if tag == "nav" and values.get("aria-label"):
            self.has_nav_label = True
        for kind in ("claim", "decision"):
            item_id = values.get(f"data-{kind}-id", "")
            digest = values.get(f"data-{kind}-sha256", "")
            if item_id:
                self.markers[(kind, item_id)] = digest
        if tag in {"script", "img", "audio", "video", "source", "iframe"} and "src" in values:
            src = values["src"]
            if not src.startswith("data:"):
                self.external_resources.append(f"{tag}[src={src}]")
        if tag == "link" and "href" in values and not values["href"].startswith("data:"):
            self.external_resources.append(f"link[href={values['href']}]")
        if tag == "form" and values.get("action"):
            self.external_resources.append(f"form[action={values['action']}]")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(131072), b""):
            digest.update(chunk)
    return digest.hexdigest()


def parse_iso(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        from datetime import datetime
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.tzinfo is not None
    except ValueError:
        return False


def within(base: Path, relative: Any, label: str, errors: list[str]) -> Path | None:
    if not isinstance(relative, str) or not relative or Path(relative).is_absolute():
        errors.append(f"{label} path must be a non-empty relative path")
        return None
    target = (base / relative).resolve()
    try:
        target.relative_to(base.resolve())
    except ValueError:
        errors.append(f"{label} path escapes the output directory")
        return None
    return target


def validate_contract(data: Any, errors: list[str]) -> None:
    if not isinstance(data, dict):
        errors.append("contract root must be an object")
        return
    extra = sorted(set(data) - ALLOWED_TOP)
    missing = sorted(ALLOWED_TOP - set(data))
    if extra:
        errors.append("unknown contract keys: " + ", ".join(extra))
    if missing:
        errors.append("missing contract keys: " + ", ".join(missing))
    if data.get("schema_version") != "dual-audience-report-contract-v1":
        errors.append("unsupported schema_version")
    if not re.fullmatch(r"DAR-[A-F0-9]{12}", str(data.get("report_id", ""))):
        errors.append("report_id must match DAR-[A-F0-9]{12}")
    if not isinstance(data.get("title"), str) or not data.get("title", "").strip():
        errors.append("title is required")
    if not parse_iso(data.get("as_of")):
        errors.append("as_of must be an ISO-8601 timestamp with timezone")
    if data.get("repository_status") not in {"local-only", "tracked-approved", "public-approved"}:
        errors.append("invalid repository_status")
    if not isinstance(data.get("source_hierarchy"), list) or not data.get("source_hierarchy"):
        errors.append("source_hierarchy must contain at least one source")
    deliverables = data.get("deliverables")
    if not isinstance(deliverables, dict) or set(deliverables) != {"agent", "human"}:
        errors.append("deliverables must contain exactly agent and human")
    for collection, prefix in ((data.get("claims"), "C"), (data.get("decisions"), "D")):
        if not isinstance(collection, list):
            errors.append(f"{prefix} items must be an array")
            continue
        seen: set[str] = set()
        for item in collection:
            if not isinstance(item, dict):
                errors.append(f"{prefix} item must be an object")
                continue
            item_id = str(item.get("id", ""))
            if not re.fullmatch(prefix + r"-\d{3}", item_id) or item_id in seen:
                errors.append(f"invalid or duplicate {prefix} item id: {item_id}")
            seen.add(item_id)
            if not isinstance(item.get("summary"), str) or not item.get("summary", "").strip():
                errors.append(f"{item_id or prefix} summary is required")
            if item.get("confidence") not in {"high", "medium", "low", "unknown"}:
                errors.append(f"{item_id or prefix} has invalid confidence")
            required_in = item.get("required_in")
            if not isinstance(required_in, list) or any(value not in {"agent", "human"} for value in required_in):
                errors.append(f"{item_id or prefix} required_in is invalid")


def scan_text(text: str, label: str, errors: list[str]) -> None:
    if PLACEHOLDER.search(text):
        errors.append(f"{label} contains an unfinished placeholder")
    if SECRET.search(text):
        errors.append(f"{label} contains a credential-like value")
    if PRIVATE_PATH.search(text):
        errors.append(f"{label} contains a personal absolute path")
    if SESSION_ID.search(text):
        errors.append(f"{label} contains a Session identifier")


def expected_markers(data: dict[str, Any]) -> dict[tuple[str, str], str]:
    result: dict[tuple[str, str], str] = {}
    for collection, kind in ((data.get("claims", []), "claim"), (data.get("decisions", []), "decision")):
        for item in collection:
            digest = sha256_text(item["summary"])
            for audience in item.get("required_in", []):
                result[(audience + ":" + kind, item["id"])] = digest
    return result


def validate_markdown_links(text: str, base: Path, errors: list[str]) -> None:
    for raw in MD_LINK.findall(text):
        target = raw.split("#", 1)[0].strip(" <>")
        if not target or re.match(r"^[a-z]+:", target, re.I):
            continue
        path = within(base, target, "Markdown link", errors)
        if path and not path.exists():
            errors.append(f"Markdown link target does not exist: {target}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--contract", type=Path, required=True)
    parser.add_argument("--handoff-file", type=Path, help="Optional final-message draft that must link both artifacts")
    parser.add_argument("--receipt-dir", type=Path)
    args = parser.parse_args()

    contract_path = args.contract.expanduser().resolve()
    errors: list[str] = []
    try:
        data = json.loads(contract_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "failed", "errors": [f"cannot read contract: {type(exc).__name__}"]}, indent=2))
        return 2
    validate_contract(data, errors)
    if errors and not isinstance(data, dict):
        print(json.dumps({"status": "failed", "errors": errors}, indent=2))
        return 1

    contract_text = json.dumps(data, ensure_ascii=False)
    if PLACEHOLDER.search(contract_text):
        errors.append("contract contains an unfinished placeholder")

    output_base = within(contract_path.parent, data.get("output_dir", "."), "output_dir", errors)
    output_base = output_base or contract_path.parent
    deliverables = data.get("deliverables", {}) if isinstance(data.get("deliverables"), dict) else {}
    paths: dict[str, Path] = {}
    texts: dict[str, str] = {}
    for audience, expected_format in (("agent", "markdown"), ("human", "html")):
        item = deliverables.get(audience)
        if not isinstance(item, dict):
            continue
        if item.get("audience") != audience or item.get("format") != expected_format:
            errors.append(f"{audience} deliverable audience/format mismatch")
        required = item.get("required") is True
        waived = item.get("status") == "waived" and isinstance(item.get("waiver_reason"), str) and len(item["waiver_reason"].strip()) >= 12
        if not required and not waived:
            errors.append(f"{audience} may be optional only with an explicit waiver reason")
        target = within(output_base, item.get("path"), audience, errors)
        if not target:
            continue
        paths[audience] = target
        if waived:
            continue
        if not target.is_file():
            errors.append(f"missing {audience} artifact: {item.get('path')}")
            continue
        try:
            text = target.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            errors.append(f"{audience} artifact is not UTF-8")
            continue
        if len(text.strip()) < 300:
            errors.append(f"{audience} artifact is too short to be complete")
        scan_text(text, audience, errors)
        texts[audience] = text

    report_id = str(data.get("report_id", ""))
    as_of = str(data.get("as_of", ""))
    agent_text = texts.get("agent", "")
    if agent_text:
        if f"<!-- report-id: {report_id} -->" not in agent_text:
            errors.append("Agent report_id marker is missing or stale")
        if f"<!-- report-as-of: {as_of} -->" not in agent_text:
            errors.append("Agent as_of marker is missing or stale")
        required_headings = ("## Contract", "## Source hierarchy", "## Current state", "## Decisions", "## Next actions", "## Validation evidence")
        for heading in required_headings:
            if heading not in agent_text:
                errors.append(f"Agent document is missing {heading}")
        if "synthesis, not a source of truth" not in agent_text.lower():
            errors.append("Agent document must identify itself as a synthesis")
        validate_markdown_links(agent_text, output_base, errors)

    human_text = texts.get("human", "")
    html_parser = ReportHTMLParser()
    if human_text:
        try:
            html_parser.feed(human_text)
        except Exception as exc:  # HTMLParser may surface malformed entities.
            errors.append(f"HTML parsing failed: {type(exc).__name__}")
        if html_parser.metas.get("report-id") != report_id:
            errors.append("Human report_id metadata is missing or stale")
        if html_parser.metas.get("report-as-of") != as_of:
            errors.append("Human as_of metadata is missing or stale")
        if not html_parser.has_viewport:
            errors.append("Human HTML is missing a viewport meta tag")
        if not html_parser.has_main or not html_parser.has_skip or not html_parser.has_nav_label:
            errors.append("Human HTML must have main, a skip link, and labelled navigation")
        if len(html_parser.ids) != len(set(html_parser.ids)):
            errors.append("Human HTML contains duplicate element IDs")
        missing_anchors = sorted(set(html_parser.anchors) - set(html_parser.ids))
        if missing_anchors:
            errors.append("Human HTML has broken internal anchors: " + ", ".join(missing_anchors))
        if html_parser.external_resources or re.search(r"url\(\s*['\"]?(?!data:)", human_text, re.I):
            errors.append("Human HTML references an external runtime resource")
        if ":focus-visible" not in human_text:
            errors.append("Human HTML lacks visible keyboard focus styling")
        if "Executive Summary" not in human_text and "执行摘要" not in human_text:
            errors.append("Human HTML lacks a visible Executive Summary")

    expected = expected_markers(data)
    agent_markers = {(kind, item_id): digest for kind, item_id, digest in MARKER.findall(agent_text)}
    for (audience_kind, item_id), digest in expected.items():
        audience, kind = audience_kind.split(":", 1)
        actual = agent_markers.get((kind, item_id)) if audience == "agent" else html_parser.markers.get((kind, item_id))
        if actual != digest:
            errors.append(f"{audience} has missing or stale {kind} marker for {item_id}")

    if args.handoff_file:
        try:
            handoff = args.handoff_file.read_text(encoding="utf-8")
            for audience, path in paths.items():
                item = deliverables.get(audience, {})
                if item.get("status") != "waived" and path.name not in handoff and str(path) not in handoff:
                    errors.append(f"handoff is missing the {audience} artifact link")
        except OSError as exc:
            errors.append(f"cannot read handoff file: {type(exc).__name__}")

    if errors:
        print(json.dumps({"status": "failed", "errors": sorted(set(errors))}, ensure_ascii=False, indent=2, sort_keys=True))
        return 1

    hashes = {audience: sha256_file(path) for audience, path in paths.items() if path.is_file()}
    data["validation"] = {
        "status": "passed",
        "agent_sha256": hashes.get("agent"),
        "human_sha256": hashes.get("human"),
    }
    for audience, item in deliverables.items():
        if item.get("status") != "waived":
            item["status"] = "validated"
    contract_path.write_text(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    receipt_dir = (args.receipt_dir or output_base).expanduser().resolve()
    receipt_dir.mkdir(parents=True, exist_ok=True)
    receipt = {
        "schema_version": "dual-audience-delivery-receipt-v1",
        "status": "passed",
        "report_id": report_id,
        "as_of": as_of,
        "artifacts": {
            audience: {"path": str(path.relative_to(output_base)), "sha256": hashes.get(audience)}
            for audience, path in sorted(paths.items())
            if path.is_file()
        },
        "checks": [
            "contract", "both-artifacts", "placeholders", "shared-markers",
            "internal-links", "html-structure", "external-resources", "privacy",
        ],
    }
    (receipt_dir / "delivery-receipt.json").write_text(
        json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    lines = [
        "# Delivery receipt", "", f"- **Report:** {report_id}", f"- **As of:** {as_of}",
        "- **Validation:** passed", "", "## Artifacts", "",
    ]
    for audience, artifact in receipt["artifacts"].items():
        lines.append(f"- [{audience.title()} report]({artifact['path']}) — `{artifact['sha256']}`")
    lines.extend(["", "Both required artifacts are ready to link in the final response.", ""])
    (receipt_dir / "delivery-receipt.md").write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps(receipt, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
