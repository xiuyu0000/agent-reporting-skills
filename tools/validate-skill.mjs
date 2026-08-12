import { spawnSync } from "node:child_process";
import process from "node:process";

const executable = process.env.SKILLS_REF_BIN ?? "skills-ref";
const result = spawnSync(executable, ["validate", "skills/deliver-dual-audience-report"], {
  encoding: "utf8",
  stdio: "inherit",
});

if (result.error) {
  console.error(`unable to execute pinned Skill validator: ${result.error.message}`);
  console.error("install the validator version pinned by .github/workflows/validate.yml or set SKILLS_REF_BIN");
  process.exit(3);
}

process.exit(result.status ?? 70);
