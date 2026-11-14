// Every call this vessel serves bounds itself, so it can tell discovery to hold its calls with no limit
// (RESOLVE_TIMEOUT_MS, index.ts). That holds only while every subprocess started in src carries its own bound: a signal
// (Bun.spawn) or a timeout (spawnSync, execFileSync). A new site without one goes red here; a site left unbounded on
// purpose is named below with the reason, so the list stays in view.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir);
const files = readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helper.ts") && !f.endsWith(".d.ts"));
const CALL = /(?<![\w$])(?:Bun\.spawnSync|Bun\.spawn|spawnSync|execSync|execFileSync|execFile|spawn)\(/g;

// The text of a call's arguments: from its "(" to the ")" that closes it.
const argsAt = (s: string, open: number): string => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")" && --depth === 0) return s.slice(open + 1, i);
  }
  return s.slice(open + 1);
};

// Sites left unbounded on purpose: each is bounded by something other than its own option, said here. A site is matched
// by a piece of its argument text.
const EXEMPT: Array<{ file: string; has: string; why: string }> = [
  { file: "script-runner-reaper.ts", has: "argv, { stdin: \"ignore\", stdout: \"inherit\"", why: "the script under the reaper: its run is timed by script-runner, which kills the reaper's whole process group when the run's timeout passes" },
  { file: "script-runner.ts", has: "REAPER, \"bash\"", why: "the reaper itself: its run's timer (setTimeout ... killTree) ends it at the run's timeout, capped by MAX_TIMEOUT_S, or MAX_ASYNC_TIMEOUT_S for an async run, which answers its caller at once" },
  { file: "bounded-run.ts", has: "stdin: o.stdin ?? \"ignore\", detached: true", why: "runBounded: its own process group, killed whole by its own timer at the bound, its pipes not waited on past it (step-bound.test.ts and git-bound.test.ts hold this by effect)" },
  { file: "shell-privilege.ts", has: "\"find\", home, \"-mindepth\"", why: "the shell user's HOME emptied after a command: no caller awaits it (done() is fire-and-forget), so it holds no call open" },
];

describe("every subprocess in src is bounded", () => {
  const sites: Array<{ file: string; line: number; text: string }> = [];
  for (const f of files) {
    const s = readFileSync(join(SRC, f), "utf8");
    for (const m of s.matchAll(CALL)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      sites.push({ file: f, line: s.slice(0, m.index).split("\n").length, text: argsAt(s, open) });
    }
  }

  test("[MUST-FAIL] each subprocess site passes a signal or a timeout, or is named as exempt with its reason", () => {
    expect(sites.length).toBeGreaterThan(10);
    const unbounded = sites
      .filter((c) => !/\b(signal|timeout)\s*:/.test(c.text))
      .filter((c) => !EXEMPT.some((e) => e.file === c.file && c.text.includes(e.has)))
      .map((c) => `${c.file}:${c.line}`);
    expect(unbounded).toEqual([]);
  });

  test("every exemption still names a site (none is left over from code that is gone)", () => {
    const stale = EXEMPT.filter((e) => !sites.some((c) => c.file === e.file && c.text.includes(e.has))).map((e) => `${e.file}: ${e.has}`);
    expect(stale).toEqual([]);
  });
});

describe("discovery holds this vessel's calls with no limit", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const declared = /export const RESOLVE_TIMEOUT_MS = (\d+);/.exec(index);
  // The largest bound any call sets itself, read from where it is set.
  const num = (file: string, name: string, scale = 1): number => {
    const m = new RegExp(`const ${name} = ([\\d_ *]+);`).exec(readFileSync(join(SRC, file), "utf8"));
    expect(m).not.toBeNull();
    return Function(`return ${m![1].replace(/_/g, "")}`)() * scale;
  };

  test("[MUST-FAIL] lt declares RESOLVE_TIMEOUT_MS: a timer's largest delay, never more, and no less than any call's own bound", () => {
    expect(declared).not.toBeNull();
    const v = Number(declared![1]);
    expect(v).toBeGreaterThan(0);
    // above 2^31 - 1 a timer can fire at once: "no limit" would become "cut at once"
    expect(v).toBeLessThanOrEqual(2147483647);
    const own = Math.max(num("git-land.ts", "STEP_MS"), num("git-commit.ts", "GIT_TIMEOUT_MS"), num("script-runner.ts", "EXPORT_STEP_MS"),
      num("index.ts", "MAX_TIMEOUT_SEC", 1000), num("script-runner.ts", "MAX_TIMEOUT_S", 1000));
    expect(v).toBeGreaterThanOrEqual(own);
  });

  test("[MUST-FAIL] the daemon registers with it", () => {
    expect(index).toMatch(/new VesselDaemon\(\{[\s\S]*?resolveTimeoutMs: RESOLVE_TIMEOUT_MS,/);
  });
});
