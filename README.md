# agentsfile

**Agent instruction files rot quietly. This checks them against the repo they describe.**

AGENTS.md and CLAUDE.md tell coding agents how a repo works: which files matter, which commands to run, how the project is laid out. Repos move faster than their instruction files. A renamed directory, a deleted script, a guide that was never more than a stub, and the agent following the file wastes its run or invents what the file got wrong. Nothing fails loudly, because nothing ever checked the file against the repo.

agentsfile does that check. It reads the AGENTS.md and CLAUDE.md at a repo root, extracts the backticked paths and the npm, yarn, and pnpm script references, and verifies each one against the actual file tree and the actual package.json. Every finding carries the file, the line, and the exact text it came from. The output is deterministic: sorted findings, no timestamps, the same repo always producing the same report.

## What it checks

| rule | severity | what it means |
| --- | --- | --- |
| `NO-FILE` | high | Neither AGENTS.md nor CLAUDE.md exists at the repo root. |
| `PATH-MISSING` | medium | A backticked span that looks like a relative path does not exist in the repo, as a file or as a directory. |
| `SCRIPT-MISSING` | medium | A referenced script (`npm run <name>`, `npm test`, `yarn <name>`, `pnpm <name>` and friends) is not defined in package.json scripts. |
| `STUB` | low | An agent file exists but is empty or under 5 lines long. |
| `NO-PACKAGE-JSON` | info | There is no package.json at the repo root (or it does not parse), so script references were not checked. |

Verdict rules:

- **VALID**: no medium or high findings. Low and info findings can be present. Exit code 0.
- **DRIFT**: at least one medium or high finding. The agent files disagree with the repo. Exit code 1.
- **MISSING**: neither AGENTS.md nor CLAUDE.md exists at the repo root. Exit code 1.
- **Usage errors** exit with code 2. A reader that closes the output pipe early makes the process exit 141, never 0.

Script reference details: `npm run <name>` checks `<name>` directly. The conventional shorthands `npm test` and `npm start` (plus `stop` and `restart`) map to the script of the same name. For yarn and pnpm, `<manager> <name>` and `<manager> run <name>` check `<name>`, and the package managers' own builtin subcommands (install, add, publish, and friends) are never treated as scripts.

## Usage

### CLI

```bash
# Check the current repo
npx @reneturcios/agentsfile check

# Check another repo, machine readable
npx @reneturcios/agentsfile check ~/src/my-repo --json

# Print the version
npx @reneturcios/agentsfile --version
```

Example output:

```text
agentsfile check .: DRIFT
  files: 2, findings: 2 (high: 0, medium: 2, low: 0, info: 0)
  summary: 2 agent file(s) checked; 2 finding(s): 0 high, 2 medium, 0 low, 0 info. Verdict: DRIFT.

AGENTS.md:
  [MEDIUM] line 4 PATH-MISSING `src/gone.ts` Referenced path does not exist in the repo: src/gone.ts
  [MEDIUM] line 5 SCRIPT-MISSING `npm run deploy` Script referenced but not defined in package.json scripts: deploy

DRIFT: at least one medium or high finding; the agent files disagree with the repo.
```

With `--json` the full report is printed as JSON: tool, version, target, verdict, counts (files, findings, and per-severity totals), the findings array, and a one-line summary. Checking needs no credentials and no network, and nothing in the target repo is executed.

The target may also be a single agent instruction file instead of a directory; its own directory is then treated as the repo root and only that file is checked.

### MCP server

```bash
npx @reneturcios/agentsfile mcp
```

Add to your MCP client config:

```json
{
  "mcpServers": {
    "agentsfile": {
      "command": "npx",
      "args": ["-y", "@reneturcios/agentsfile", "mcp"]
    }
  }
}
```

Tool: `check_agents_file(path)` returns the full check report for the repo (or single file) at `path`, as JSON.

## Limits, stated plainly

- Only AGENTS.md and CLAUDE.md at the repo root are read. Nested agent files in subdirectories are not checked in this version.
- Only two kinds of reference are checked: backticked spans, and npm, yarn, and pnpm script patterns. Commands shown in fenced code blocks are found by the script patterns, but paths in fenced blocks without backticks are not checked, and neither are links, prose mentions, or commands from other toolchains (make, cargo, go, and so on).
- Path detection is a heuristic, stated honestly: a backticked span counts as a path if it has no spaces, does not start with http, and either contains a slash or ends in a dotted segment that looks like a file extension from a known list (plus a small set of known dotfiles such as `.env`). Tokens containing characters such as `@`, `:`, `*`, `=`, or quotes are never treated as paths, so scoped package names and action references are not flagged. The flip side is real: an unusual file name can be missed, and an odd token that happens to look like a path can be flagged. Findings always quote the exact span so a human can judge in one glance.
- The check is existence only. A path that exists is not checked for being the right file, and a script that exists is not checked for doing what the guide claims it does.
- The stub rule is a line count (under 5 lines), not a quality judgment. A short file that is genuinely complete will still be reported at low severity, which never changes the verdict on its own.
