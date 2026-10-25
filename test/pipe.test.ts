/**
 * Pipe regression tests, inherited from the factory emit contract
 * (FACTORY-NOTES.md; ledger P-001, P-017, P-021 in the tranche 1 tools).
 *
 * Node stdout attached to a pipe is asynchronous: console.log followed
 * by process.exit discards whatever the pipe has not drained, truncating
 * at one 64 KiB pipe buffer while the exit code still reports success.
 * These tests spawn the real CLI with piped stdio and push a report past
 * 200 KiB through the pipe. The fixture is one repo whose AGENTS.md
 * names 3000 missing paths, one per line, so the JSON report is large.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { runCheck, renderReport } from "../src/core.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MISSING_PATHS = 3000;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agentsfile-pipe-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A repo whose AGENTS.md references 3000 paths that do not exist. */
function writeBigRepo(root: string): void {
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "big", private: true, scripts: {} }) + "\n", "utf8");
  const lines = ["# Big agent guide", ""];
  for (let i = 0; i < MISSING_PATHS; i++) {
    lines.push(`See \`src/missing-${i}.ts\` for details.`);
  }
  writeFileSync(join(root, "AGENTS.md"), lines.join("\n") + "\n", "utf8");
}

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { destroyStdoutOnFirstChunk?: boolean } = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("CLI timed out"));
    }, 90000);
    if (opts.destroyStdoutOnFirstChunk) {
      // Close the read end immediately, before the child has even finished
      // computing its report. Destroying only on the first chunk races the
      // writer: if the whole write lands in the kernel pipe buffer before
      // the destroy lands, no EPIPE occurs and the process exits with its
      // verdict code (observed on the Node 20 CI matrix, ledger P-153).
      child.stdout.destroy();
    }
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (opts.destroyStdoutOnFirstChunk) child.stdout.destroy();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: out, stderr: err });
    });
  });
}

describe("emit contract: piped output is delivered whole", () => {
  it("piped --json check over 200 KiB parses and matches the in-process report", { timeout: 120000 }, async () => {
    writeBigRepo(dir);
    const direct = runCheck(dir);
    const directJson = JSON.stringify(direct, null, 2);
    assert.ok(directJson.length > 200_000, `fixture must exceed 200 KiB of JSON, got ${directJson.length}`);
    const res = await runCli(["check", dir, "--json"]);
    assert.equal(res.code, 1, `expected exit 1 (DRIFT), got ${res.code} (stderr: ${res.stderr.slice(0, 200)})`);
    assert.equal(res.stdout.length, directJson.length + 1, "piped bytes must equal the full report plus the trailing newline");
    const parsed = JSON.parse(res.stdout) as { counts: { findings: number }; verdict: string };
    assert.equal(parsed.counts.findings, direct.counts.findings);
    assert.equal(parsed.counts.findings, MISSING_PATHS);
    assert.equal(parsed.verdict, "DRIFT");
  });

  it("piped human check output is byte-identical to the in-process render", { timeout: 120000 }, async () => {
    writeBigRepo(dir);
    const expected = renderReport(runCheck(dir)) + "\n";
    assert.ok(expected.length > 65_536, `human fixture must exceed one pipe buffer, got ${expected.length}`);
    const res = await runCli(["check", dir]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, expected);
  });

  it("a reader that closes the pipe early never sees a success exit", { timeout: 120000 }, async () => {
    writeBigRepo(dir);
    const res = await runCli(["check", dir, "--json"], { destroyStdoutOnFirstChunk: true });
    assert.notEqual(res.code, 0, "exit 0 would report success for output that was never delivered");
    assert.ok(res.signal === "SIGPIPE" || res.code === 141, `expected SIGPIPE or exit 141, got code ${res.code} signal ${res.signal}`);
  });
});
