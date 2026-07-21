from __future__ import annotations

import hashlib
import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/deliver-dual-audience-report"
INIT = SKILL / "scripts/init_delivery.py"
VALIDATE = SKILL / "scripts/validate_delivery.py"


def digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class DeliveryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.output = Path(self.temp.name) / "report"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def initialize(self) -> None:
        result = subprocess.run(
            [
                "python3", str(INIT), "--output-dir", str(self.output),
                "--base-name", "synthetic-review", "--title", "Synthetic Review",
                "--language", "en", "--as-of", "2026-07-21T16:00:00+08:00",
            ],
            text=True, capture_output=True, check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def complete(self) -> tuple[Path, Path, Path]:
        self.initialize()
        contract_path = self.output / "report-contract.json"
        agent_path = self.output / "synthetic-review_AGENT.md"
        human_path = self.output / "synthetic-review_HUMAN.html"
        contract = json.loads(contract_path.read_text(encoding="utf-8"))
        claim = "The reviewed service is ready for a controlled pilot."
        decision = "Run a two-week pilot before wider adoption."
        contract["source_hierarchy"] = [
            {"rank": 1, "label": "Synthetic test source", "reference": "fixture-source", "freshness": "static"}
        ]
        contract["claims"] = [
            {"id": "C-001", "summary": claim, "confidence": "high", "source_refs": ["fixture-source"], "required_in": ["agent", "human"]}
        ]
        contract["decisions"] = [
            {"id": "D-001", "summary": decision, "confidence": "high", "source_refs": ["fixture-source"], "required_in": ["agent", "human"]}
        ]
        contract["constraints"] = ["Use only synthetic data."]
        contract["risks"] = ["Pilot results may not generalize."]
        contract["open_questions"] = ["Which team owns the wider rollout?"]
        for item in contract["deliverables"].values():
            item["status"] = "draft"
        contract_path.write_text(json.dumps(contract, indent=2, sort_keys=True) + "\n", encoding="utf-8")

        replacements = {
            "{{REPLACE_SCOPE}}": "Evaluate readiness for a controlled pilot.",
            "{{REPLACE_EXCLUSIONS}}": "Production rollout and commercial decisions.",
            "{{REPLACE_PRIMARY_SOURCE}}": "Synthetic test source (static fixture).",
            "{{REPLACE_PRECISE_STATE}}": "The review is complete and all deterministic checks passed in the fixture.",
            "{{REPLACE_SHARED_FACTS}}": f"<!-- claim:C-001:{digest(claim)} -->\n- **C-001:** {claim}",
            "{{REPLACE_DECISIONS_AND_RATIONALE}}": f"<!-- decision:D-001:{digest(decision)} -->\n- **D-001:** {decision} This limits exposure while collecting evidence.",
            "{{REPLACE_CONSTRAINTS_INTERFACES_COMMANDS_OR_PSEUDOCODE}}": "Use synthetic inputs and stop if validation fails.",
            "{{REPLACE_RISKS_BLOCKERS_AND_OPEN_QUESTIONS}}": "Results may not generalize; rollout ownership remains open.",
            "{{REPLACE_NEXT_ACTIONS}}": "Run the pilot, collect outcomes, then make a new decision.",
            "{{REPLACE_VALIDATION_EVIDENCE_AND_GAPS}}": "Fixture structure and delivery markers were checked; real-world performance is not covered.",
        }
        agent = agent_path.read_text(encoding="utf-8")
        for old, new in replacements.items():
            agent = agent.replace(old, new)
        agent_path.write_text(agent, encoding="utf-8")

        human_replacements = {
            "{{REPLACE_CONCLUSION_AND_WHY_IT_MATTERS}}": "The service is ready for a small pilot, which provides evidence without exposing a broad audience.",
            "{{REPLACE_SHARED_FACTS_AND_LOCAL_UNCERTAINTY}}": f'<span data-claim-id="C-001" data-claim-sha256="{digest(claim)}">{claim}</span> The wider result remains uncertain.',
            "{{REPLACE_CONTEXT}}": "A team needed to decide whether testing should expand.",
            "{{REPLACE_CHANGE}}": "The review found enough evidence for a limited next step.",
            "{{REPLACE_IMPACT}}": "A pilot gathers better evidence while containing risk.",
            "{{REPLACE_DECISION_ALTERNATIVES_AND_TRADEOFFS}}": f'<span data-decision-id="D-001" data-decision-sha256="{digest(decision)}">{decision}</span> Immediate rollout was faster but riskier.',
            "{{REPLACE_NEXT_STEP_OWNER_AND_STOP_CONDITION}}": "The pilot owner runs two weeks of testing and stops if validation fails.",
            "{{REPLACE_SOURCE_SUMMARY_AND_EVIDENCE_GAPS}}": "The conclusion uses a static synthetic fixture; it does not predict production performance.",
            "{{REPLACE_TERM}}": "Controlled pilot",
            "{{REPLACE_PLAIN_LANGUAGE_DEFINITION}}": "A small, time-limited test with a clear stop condition.",
        }
        human = human_path.read_text(encoding="utf-8")
        for old, new in human_replacements.items():
            human = human.replace(old, new)
        human_path.write_text(human, encoding="utf-8")
        return contract_path, agent_path, human_path

    def validate(self, contract: Path, handoff: Path | None = None) -> subprocess.CompletedProcess[str]:
        command = ["python3", str(VALIDATE), "--contract", str(contract)]
        if handoff:
            command.extend(["--handoff-file", str(handoff)])
        return subprocess.run(command, text=True, capture_output=True, check=False)

    def test_happy_path_is_stable(self) -> None:
        contract, _, _ = self.complete()
        first = self.validate(contract)
        self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
        receipt = (self.output / "delivery-receipt.json").read_bytes()
        contract_after = contract.read_bytes()
        second = self.validate(contract)
        self.assertEqual(second.returncode, 0, second.stdout + second.stderr)
        self.assertEqual(receipt, (self.output / "delivery-receipt.json").read_bytes())
        self.assertEqual(contract_after, contract.read_bytes())

    def test_initial_skeleton_fails(self) -> None:
        self.initialize()
        result = self.validate(self.output / "report-contract.json")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("placeholder", result.stdout)

    def test_injected_defects_fail_closed(self) -> None:
        cases = {
            "missing-human": ("missing human artifact", lambda c, a, h: h.unlink()),
            "wrong-directory": ("escapes the output directory", lambda c, a, h: self._edit_contract(c, lambda d: d["deliverables"]["human"].update(path="../leak.html"))),
            "stale-claim": ("stale claim marker", lambda c, a, h: a.write_text(a.read_text().replace(digest("The reviewed service is ready for a controlled pilot."), "0" * 64), encoding="utf-8")),
            "outdated-time": ("as_of metadata", lambda c, a, h: self._edit_contract(c, lambda d: d.update(as_of="2026-07-22T16:00:00+08:00"))),
            "broken-anchor": ("broken internal anchors", lambda c, a, h: h.write_text(h.read_text().replace('href="#glossary"', 'href="#missing"'), encoding="utf-8")),
            "duplicate-id": ("duplicate element IDs", lambda c, a, h: h.write_text(h.read_text().replace('id="story"', 'id="summary"'), encoding="utf-8")),
            "external-resource": ("external runtime resource", lambda c, a, h: h.write_text(h.read_text().replace("</head>", '<script src="https://cdn.example.test/app.js"></script></head>'), encoding="utf-8")),
            "credential": ("credential-like", lambda c, a, h: a.write_text(a.read_text() + "\nAuthorization: " + "Bearer " + "synthetic_secret_123456\n", encoding="utf-8")),
            "personal-path": ("personal absolute path", lambda c, a, h: a.write_text(a.read_text() + "\n/" + "Users/example/private/report.md\n", encoding="utf-8")),
        }
        for name, (message, mutate) in cases.items():
            with self.subTest(name=name):
                self.tearDown()
                self.setUp()
                contract, agent, human = self.complete()
                mutate(contract, agent, human)
                result = self.validate(contract)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(message, result.stdout)

    def test_handoff_requires_both_links(self) -> None:
        contract, _, _ = self.complete()
        handoff = self.output / "handoff.md"
        handoff.write_text("[Agent](synthetic-review_AGENT.md)\n", encoding="utf-8")
        result = self.validate(contract, handoff)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing the human artifact link", result.stdout)

    @staticmethod
    def _edit_contract(path: Path, edit) -> None:
        data = json.loads(path.read_text(encoding="utf-8"))
        edit(data)
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")


class StructureTest(unittest.TestCase):
    def test_skill_frontmatter_and_trigger_fixtures(self) -> None:
        text = (SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("---\nname: deliver-dual-audience-report\n"))
        self.assertNotRegex(text, r"\bTODO\b|\[TODO")
        fixtures = json.loads((ROOT / "tests/fixtures/trigger-cases.json").read_text(encoding="utf-8"))
        self.assertEqual(len(fixtures["should_trigger"]), 4)
        self.assertEqual(len(fixtures["should_not_trigger"]), 4)

    def test_public_tree_has_no_private_material(self) -> None:
        personal_name = "star" + "spulse"
        forbidden = re.compile(rf"(?i)(?:{personal_name}|[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}|gh[pousr]_[a-z0-9]{{20,}})")
        for path in ROOT.rglob("*"):
            if path.is_file() and ".git" not in path.parts and path.suffix.lower() in {".md", ".html", ".json", ".yaml", ".yml", ".py"}:
                text = path.read_text(encoding="utf-8")
                self.assertIsNone(forbidden.search(text), str(path.relative_to(ROOT)))


if __name__ == "__main__":
    unittest.main()
