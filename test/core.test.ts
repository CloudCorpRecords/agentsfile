import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck, renderReport, CLEAN_VERDICT, VERSION } from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const fixture = (name: string): string => join(FIXTURES, name);

describe("contract", () => {
  it("exports the fleet version and clean verdict", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "VALID");
  });
});

describe("repo-good: everything referenced exists", () => {
  it("is VALID with no findings", () => {
    const r = runCheck(fixture("repo-good"));
    assert.equal(r.tool, "agentsfile");
    assert.equal(r.version, "0.1.0");
    assert.equal(r.verdict, "VALID");
    assert.deepEqual(r.findings, []);
    assert.equal(r.counts.files, 2);
    assert.equal(r.counts.findings, 0);
  });
});

describe("repo-drift: a missing path and a missing script", () => {
  it("is DRIFT with the exact findings in sorted order", () => {
    const r = runCheck(fixture("repo-drift"));
    assert.equal(r.verdict, "DRIFT");
    assert.equal(r.counts.files, 2);
    assert.equal(r.counts.findings, 2);
    assert.equal(r.counts.medium, 2);
    assert.deepEqual(
      r.findings.map((f) => [f.rule, f.severity, f.file, f.line, f.evidence]),
      [
        ["PATH-MISSING", "medium", "AGENTS.md", 4, "src/gone.ts"],
        ["SCRIPT-MISSING", "medium", "AGENTS.md", 5, "npm run deploy"],
      ],
    );
  });

  it("does not flag the fine CLAUDE.md", () => {
    const r = runCheck(fixture("repo-drift"));
    assert.ok(r.findings.every((f) => f.file === "AGENTS.md"));
  });
});

describe("repo-none: no agent files", () => {
  it("is MISSING with one high NO-FILE finding", () => {
    const r = runCheck(fixture("repo-none"));
    assert.equal(r.verdict, "MISSING");
    assert.equal(r.counts.files, 0);
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].rule, "NO-FILE");
    assert.equal(r.findings[0].severity, "high");
    assert.equal(r.counts.high, 1);
  });
});

describe("repo-stub: an agent file that is only a stub", () => {
  it("reports one low STUB finding and stays VALID", () => {
    const r = runCheck(fixture("repo-stub"));
    assert.equal(r.verdict, "VALID");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].rule, "STUB");
    assert.equal(r.findings[0].severity, "low");
    assert.equal(r.findings[0].file, "AGENTS.md");
    assert.equal(r.findings[0].line, 1);
  });
});

describe("repo-nopkg: script checks need a package.json", () => {
  it("skips script checks and emits one info finding", () => {
    const r = runCheck(fixture("repo-nopkg"));
    assert.equal(r.verdict, "VALID");
    assert.equal(r.findings.length, 1);
    assert.equal(r.findings[0].rule, "NO-PACKAGE-JSON");
    assert.equal(r.findings[0].severity, "info");
    assert.match(r.findings[0].message, /script references were not checked/);
    assert.ok(r.findings.every((f) => f.rule !== "SCRIPT-MISSING"));
  });
});

describe("single file targets", () => {
  it("checks only the named file, against its own directory", () => {
    const drift = runCheck(join(fixture("repo-drift"), "AGENTS.md"));
    assert.equal(drift.verdict, "DRIFT");
    assert.equal(drift.counts.files, 1);
    assert.equal(drift.findings.length, 2);
    const fine = runCheck(join(fixture("repo-drift"), "CLAUDE.md"));
    assert.equal(fine.verdict, "VALID");
    assert.equal(fine.counts.files, 1);
    assert.deepEqual(fine.findings, []);
  });

  it("throws for a target that does not exist", () => {
    assert.throws(() => runCheck(fixture("repo-absent")), /does not exist/);
  });
});

describe("determinism and rendering", () => {
  it("two runs over the same repo are identical", () => {
    const a = runCheck(fixture("repo-drift"));
    const b = runCheck(fixture("repo-drift"));
    assert.deepEqual(a, b);
    assert.equal(renderReport(a), renderReport(b));
  });

  it("renderReport prints per-file sections and a summary", () => {
    const r = runCheck(fixture("repo-drift"));
    const text = renderReport(r);
    assert.match(text, /^agentsfile check .*?: DRIFT$/m);
    assert.match(text, /summary: 2 agent file\(s\) checked; 2 finding\(s\)/);
    assert.match(text, /^AGENTS\.md:$/m);
    assert.match(text, /\[MEDIUM\] line 4 PATH-MISSING `src\/gone\.ts`/);
    assert.match(text, /\[MEDIUM\] line 5 SCRIPT-MISSING `npm run deploy`/);
    assert.match(text, /^DRIFT: at least one medium or high finding/m);
  });

  it("renderReport for a clean repo states the VALID verdict", () => {
    const text = renderReport(runCheck(fixture("repo-good")));
    assert.match(text, /: VALID$/m);
    assert.match(text, /^VALID: no medium or high findings/m);
    assert.ok(!text.includes("PATH-MISSING"));
    assert.ok(!text.includes("SCRIPT-MISSING"));
  });
});
