/**
 * agentsfile core: validate a repo's AGENTS.md and CLAUDE.md against
 * the repo itself.
 *
 * Each agent instruction file at the repo root is parsed line by line.
 * Backticked spans that look like relative paths are checked against
 * the file tree, and npm, yarn, and pnpm script references are checked
 * against the scripts defined in package.json. A file that exists but
 * is empty or only a few lines long is reported as a stub. Nothing in
 * the target repo is executed and nothing is written.
 *
 * The report is deterministic: findings are sorted by file, then line,
 * then rule (the sort is stable, so ties keep scan order), and no
 * timestamps or environment data are included.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolve } from "node:path";
import type { Finding, Report } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "VALID";

const AGENT_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** A file with fewer lines than this is a stub, not a guide. */
const STUB_LINE_LIMIT = 5;

/* ------------------------------------------------------------------ */
/* Path detection                                                      */
/* ------------------------------------------------------------------ */

/**
 * Extensions that make a bare dotted token look like a file. A token
 * whose final dotted segment is not in this set (a version number, a
 * dotted expression, a tool name like node.js is the accepted cost) is
 * not treated as a path unless it contains a slash.
 */
const KNOWN_EXTENSIONS = new Set([
  "astro", "bash", "bat", "c", "cfg", "clj", "conf", "cpp", "cs", "css",
  "csv", "cts", "diff", "env", "erl", "ex", "exs", "fish", "go", "gql",
  "gradle", "graphql", "gz", "h", "hcl", "hpp", "hs", "htm", "html",
  "ico", "ini", "ipynb", "java", "jpeg", "jpg", "js", "json", "jsonc",
  "jsx", "kt", "less", "lock", "lua", "markdown", "md", "ml", "mjs",
  "mts", "patch", "pdf", "php", "pl", "png", "properties", "proto",
  "ps1", "py", "r", "rb", "rs", "scss", "sh", "sql", "svelte", "svg",
  "swift", "sample", "tar", "template", "tf", "toml", "tmpl", "ts",
  "tsv", "tsx", "txt", "vue", "wasm", "webp", "xml", "yaml", "yml",
  "zip", "zsh",
]);

/** Bare dotfile names that are files, not dotted expressions. */
const KNOWN_DOTFILES = new Set([
  ".babelrc", ".dockerignore", ".editorconfig", ".env", ".eslintrc",
  ".gitignore", ".node-version", ".npmrc", ".nvmrc", ".prettierrc",
  ".python-version", ".tool-versions", ".yarnrc",
]);

/** Characters that disqualify a span as a plain relative path. */
const PATH_GUARD_RE = /[\s"'`\\<>()[\]{}|;,&$#!?*=+:@]/;

function isPathLike(span: string): boolean {
  if (span.length < 3) return false;
  if (/^https?:/i.test(span)) return false;
  if (PATH_GUARD_RE.test(span)) return false;
  if (span.startsWith("/") || span.startsWith("~") || span.startsWith("-") || span.startsWith("#")) return false;
  // A leading dot is fine for ./ and ../ and for dotfiles, not otherwise.
  if (span.startsWith(".") && !span.startsWith("./") && !span.startsWith("../")) {
    const base = basename(span);
    if (!span.includes("/") && KNOWN_DOTFILES.has(base)) return true;
    if (!span.includes("/")) return false;
  }
  if (span.endsWith(".")) return false;
  if (span.includes("/")) return true;
  const base = basename(span);
  if (KNOWN_DOTFILES.has(base)) return true;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return false;
  return KNOWN_EXTENSIONS.has(base.slice(dot + 1).toLowerCase());
}

function pathExists(root: string, span: string): boolean {
  const cleaned = span.replace(/\/+$/, "");
  if (cleaned === "" || cleaned === ".") return false;
  return existsSync(join(root, cleaned));
}

/* ------------------------------------------------------------------ */
/* Script references                                                   */
/* ------------------------------------------------------------------ */

const SCRIPT_NAME = "[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*";

/** npm subcommands that are builtins, never package.json scripts. */
const NPM_SHORTHAND_SCRIPTS = new Set(["test", "start", "stop", "restart"]);

/** yarn subcommands that are builtins, never package.json scripts. */
const YARN_BUILTINS = new Set([
  "add", "bin", "cache", "config", "create", "dlx", "exec", "global",
  "help", "info", "init", "install", "link", "node", "pack", "publish",
  "remove", "run", "set", "unlink", "upgrade", "version", "why",
  "workspace", "workspaces",
]);

/** pnpm subcommands that are builtins, never package.json scripts. */
const PNPM_BUILTINS = new Set([
  "add", "audit", "bin", "config", "create", "dlx", "doctor", "env",
  "exec", "fetch", "help", "i", "import", "init", "install", "link",
  "list", "ls", "outdated", "pack", "patch", "publish", "rebuild",
  "remove", "rm", "root", "run", "store", "unlink", "update", "version",
  "why",
]);

interface ScriptRef {
  name: string;
  evidence: string;
  index: number;
}

/** Find every package script reference on a line, in line order. */
function extractScriptRefs(line: string): ScriptRef[] {
  const refs: ScriptRef[] = [];
  const collect = (re: RegExp, keep: (name: string) => boolean): void => {
    for (const m of line.matchAll(re)) {
      const name = m[1];
      if (name && keep(name)) refs.push({ name, evidence: m[0], index: m.index ?? 0 });
    }
  };
  collect(new RegExp(`\\bnpm\\s+run\\s+(${SCRIPT_NAME})`, "g"), () => true);
  collect(new RegExp(`\\bnpm\\s+(${SCRIPT_NAME})`, "g"), (n) => NPM_SHORTHAND_SCRIPTS.has(n));
  collect(new RegExp(`\\byarn\\s+run\\s+(${SCRIPT_NAME})`, "g"), () => true);
  collect(new RegExp(`\\byarn\\s+(${SCRIPT_NAME})`, "g"), (n) => !YARN_BUILTINS.has(n));
  collect(new RegExp(`\\bpnpm\\s+run\\s+(${SCRIPT_NAME})`, "g"), () => true);
  collect(new RegExp(`\\bpnpm\\s+(${SCRIPT_NAME})`, "g"), (n) => !PNPM_BUILTINS.has(n));
  refs.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return refs.filter((r) => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

/* ------------------------------------------------------------------ */
/* package.json                                                        */
/* ------------------------------------------------------------------ */

interface PackageInfo {
  present: boolean;
  parseOk: boolean;
  scripts: Set<string>;
}

function readPackage(root: string): PackageInfo {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return { present: false, parseOk: false, scripts: new Set() };
  try {
    const parsed = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: unknown };
    const scripts = new Set<string>();
    if (parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
      for (const key of Object.keys(parsed.scripts as Record<string, unknown>)) scripts.add(key);
    }
    return { present: true, parseOk: true, scripts };
  } catch {
    return { present: true, parseOk: false, scripts: new Set() };
  }
}

/* ------------------------------------------------------------------ */
/* Checking                                                            */
/* ------------------------------------------------------------------ */

function extractSpans(line: string): string[] {
  const spans: string[] = [];
  for (const m of line.matchAll(/`([^`]+)`/g)) spans.push(m[1]);
  return spans;
}

function countContentLines(lines: string[]): number {
  let n = lines.length;
  while (n > 0 && lines[n - 1] === "") n -= 1;
  return n;
}

function checkFile(root: string, file: string, pkg: PackageInfo, findings: Finding[]): void {
  const content = readFileSync(join(root, file), "utf8");
  const lines = content.split(/\r?\n/);
  const lineCount = countContentLines(lines);
  if (lineCount < STUB_LINE_LIMIT) {
    findings.push({
      rule: "STUB",
      severity: "low",
      file,
      line: 1,
      message: `${file} is a stub: ${lineCount} line(s), under the ${STUB_LINE_LIMIT} line minimum for a usable agent guide.`,
    });
  }
  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    const seenSpans = new Set<string>();
    for (const rawSpan of extractSpans(line)) {
      const span = rawSpan.trim();
      if (seenSpans.has(span)) continue;
      seenSpans.add(span);
      if (!isPathLike(span)) continue;
      if (!pathExists(root, span)) {
        findings.push({
          rule: "PATH-MISSING",
          severity: "medium",
          file,
          line: lineNo,
          message: `Referenced path does not exist in the repo: ${span}`,
          evidence: span,
        });
      }
    }
    if (pkg.present && pkg.parseOk) {
      for (const ref of extractScriptRefs(line)) {
        if (!pkg.scripts.has(ref.name)) {
          findings.push({
            rule: "SCRIPT-MISSING",
            severity: "medium",
            file,
            line: lineNo,
            message: `Script referenced but not defined in package.json scripts: ${ref.name}`,
            evidence: ref.evidence,
          });
        }
      }
    }
  });
}

function sortFindings(findings: Finding[]): void {
  findings.sort(
    (a, b) =>
      ((a.file ?? "") < (b.file ?? "") ? -1 : (a.file ?? "") > (b.file ?? "") ? 1 : 0) ||
      (a.line ?? 0) - (b.line ?? 0) ||
      (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0),
  );
}

function buildReport(target: string, filesChecked: number, findings: Finding[], verdict: string): Report {
  sortFindings(findings);
  const counts: Record<string, number> = {
    files: filesChecked,
    findings: findings.length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    info: findings.filter((f) => f.severity === "info").length,
  };
  const summary = `${counts.files} agent file(s) checked; ${counts.findings} finding(s): ${counts.high} high, ${counts.medium} medium, ${counts.low} low, ${counts.info} info. Verdict: ${verdict}.`;
  return { tool: "agentsfile", version: VERSION, target, verdict, counts, findings, summary };
}

export function runCheck(target: string): Report {
  const absTarget = resolve(target);
  let st;
  try {
    st = statSync(absTarget);
  } catch {
    throw new Error(`target does not exist: ${target}`);
  }

  let root: string;
  let files: string[];
  if (st.isFile()) {
    // A single agent instruction file: its directory is the repo root.
    root = dirname(absTarget);
    files = [basename(absTarget)];
  } else if (st.isDirectory()) {
    root = absTarget;
    files = AGENT_FILES.filter((f) => {
      try {
        return statSync(join(root, f)).isFile();
      } catch {
        return false;
      }
    });
  } else {
    throw new Error(`target is neither a file nor a directory: ${target}`);
  }

  if (files.length === 0) {
    const findings: Finding[] = [
      {
        rule: "NO-FILE",
        severity: "high",
        message: "Neither AGENTS.md nor CLAUDE.md exists at the repo root, so agents working in this repo have no instruction file to follow.",
      },
    ];
    return buildReport(target, 0, findings, "MISSING");
  }

  const pkg = readPackage(root);
  const findings: Finding[] = [];
  for (const file of files) checkFile(root, file, pkg, findings);

  if (!pkg.present) {
    findings.push({
      rule: "NO-PACKAGE-JSON",
      severity: "info",
      message: "No package.json found at the repo root, so npm script references were not checked.",
    });
  } else if (!pkg.parseOk) {
    findings.push({
      rule: "NO-PACKAGE-JSON",
      severity: "info",
      message: "package.json at the repo root could not be parsed as JSON, so npm script references were not checked.",
    });
  }

  const verdict = findings.some((f) => f.severity === "medium" || f.severity === "high") ? "DRIFT" : CLEAN_VERDICT;
  return buildReport(target, files.length, findings, verdict);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const out: string[] = [];
  out.push(`agentsfile check ${report.target}: ${report.verdict}`);
  out.push(
    `  files: ${report.counts.files}, findings: ${report.counts.findings} (high: ${report.counts.high}, medium: ${report.counts.medium}, low: ${report.counts.low}, info: ${report.counts.info})`,
  );
  out.push(`  summary: ${report.summary}`);

  const groups = new Map<string, Finding[]>();
  for (const f of report.findings) {
    const key = f.file ?? "(repo)";
    const group = groups.get(key);
    if (group) group.push(f);
    else groups.set(key, [f]);
  }
  for (const [file, group] of groups) {
    out.push("");
    out.push(`${file}:`);
    for (const f of group) {
      const where = f.line ? `line ${f.line} ` : "";
      const evidence = f.evidence ? `\`${f.evidence}\` ` : "";
      out.push(`  [${f.severity.toUpperCase()}] ${where}${f.rule} ${evidence}${f.message}`);
    }
  }

  out.push("");
  if (report.verdict === CLEAN_VERDICT) out.push("VALID: no medium or high findings; the agent files match the repo.");
  else if (report.verdict === "MISSING") out.push("MISSING: neither AGENTS.md nor CLAUDE.md exists at the repo root.");
  else out.push("DRIFT: at least one medium or high finding; the agent files disagree with the repo.");
  return out.join("\n");
}
