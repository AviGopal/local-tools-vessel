// Pins the fix for a real production defect (2026-08-30): groupBounded's watchdog
// killed by process GROUP (`kill -9 -$pgid`), which does not reach a command that
// itself invokes GNU `timeout` — `timeout` moves itself (and its child) into a NEW
// process group the instant it starts, specifically to control its own group-kill
// semantics, which incidentally escapes an OUTER group-kill aimed at the original
// subshell. Measured live: 14 orphaned `timeout`/`bun test` pairs still running
// while a concurrency governor believed only 2 were in flight, because the
// governor's slot lifecycle was tied to bash's own exit, not to the real work's.
//
// This test spawns REAL processes and checks REAL /proc state — the defect is an
// OS-level process-tree property, not something a mock can stand in for. It uses
// `sh` and `groupBounded` directly (both now exported), not a re-implementation —
// see map-path.test.ts's own header for why that distinction matters.
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

// index.ts starts a REAL HTTP server unconditionally at import time (no
// import.meta.main gate). Running inside this same live container, the real
// default port 8230 is already bound by the actual running vessel — set to a
// scratch port before importing so this test doesn't collide with it (the
// same reason map-path.test.ts's own header documents needing a hermetic
// WORKSPACE_ROOT: module-load-time side effects must be set up before import).
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const { sh, groupBounded } = await import("./index");

// pid, pgid and comm of every live process, from /proc/<pid>/stat (comm may hold spaces,
// so fields are read after its closing paren). Zombies are dead, so they are left out.
function liveStats(): Array<{ pid: number; pgid: number; comm: string }> {
  const out: Array<{ pid: number; pgid: number; comm: string }> = [];
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let s = "";
    try { s = readFileSync(`/proc/${d}/stat`, "utf8"); } catch { continue; }
    const close = s.lastIndexOf(")");
    const f = s.slice(close + 2).split(" ");
    if (f[0] === "Z" || f[0] === "X") continue;
    out.push({ pid: Number(d), pgid: Number(f[2]), comm: s.slice(s.indexOf("(") + 1, close) });
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("groupBounded / sh — full descendant tree dies on timeout", () => {
  it("kills a command that itself wraps its child in GNU timeout, including that child", async () => {
    // Mirrors the real shape observed in production: an outer `timeout` managing
    // an inner long-running command. `timeout`'s own ceiling (30s) is well past
    // this test's watchdog (2s), so the ONLY thing that can end it in time is
    // groupBounded's own kill reaching in — the process-group kill alone cannot,
    // per the module comment above.
    const marker = `/tmp/group-bounded-test-marker-${Date.now()}`;
    const { stdout } = await sh(
      `timeout 30 sh -c 'echo $$ > ${marker}; sleep 25'`,
      "/tmp",
      2,
    );
    void stdout;

    // Give the watchdog's kill (fires at ~2s) a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 500));

    const { readFileSync, existsSync, unlinkSync } = await import("node:fs");
    expect(existsSync(marker)).toBe(true);
    const innerPid = Number(readFileSync(marker, "utf8").trim());
    unlinkSync(marker);

    // The inner `sh -c '... sleep 25'` process — the one that would previously
    // survive as an orphan — must be dead, not just the outer timeout/bash.
    expect(pidAlive(innerPid)).toBe(false);
  }, 10_000);

  it("CONTROL: a job past its bound is still killed at the bound, the group backstop included", async () => {
    // The inner subshell exits at once, so its `sleep` is reparented out of the job's tree:
    // __killtree cannot reach it and only the watchdog's group kill can. It holds stdout, so
    // sh() returns only once that kill has landed, and returning near the bound proves it did.
    const t = Date.now();
    const r = await sh("( sleep 30 & echo $! ); sleep 30", "/tmp", 2);
    expect(r.exit_code).toBe(137);
    expect(Date.now() - t).toBeLessThan(5000);
    const orphan = Number(r.stdout.trim());
    expect(orphan).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 300));
    expect(liveStats().some((p) => p.pid === orphan)).toBe(false);
  }, 15_000);

  it("groupBounded's generated script defines a recursive killtree function", () => {
    const script = groupBounded("sleep 100", 5);
    expect(script).toContain("__killtree");
    expect(script).toMatch(/kill -9 "?\$__t"?/);
    // The original group-kill stays as a backstop.
    expect(script).toContain("kill -9 -$__cpid");
  });
});

describe("groupBounded / sh — a normally finished command leaves no watchdog behind", () => {
  it("MUST-FAIL: a 1 s command under a 60 s bound leaves no sleep alive in its call's groups", async () => {
    // The job prints its own pid (its group) and bash's children: the job and the watchdog,
    // whose pid is its group too (`set -m`). The watchdog's `sleep 60` is in that group.
    const r = await sh('sleep 1; echo "$BASHPID $(cat /proc/$$/task/$$/children)"', "/tmp", 60);
    expect(r.exit_code).toBe(0);
    const [job, ...kids] = r.stdout.trim().split(/\s+/).map(Number);
    const watchdog = kids.find((k) => k !== job);
    expect(job).toBeGreaterThan(0);
    expect(watchdog).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 1000));
    const left = liveStats().filter((p) => (p.pgid === job || p.pgid === watchdog) && p.comm === "sleep");
    // Clean up what a failing tree leaves, and only that (never a group found empty).
    if (left.length > 0) try { process.kill(-watchdog!, "SIGKILL"); } catch { /* already gone */ }
    expect(left.length).toBe(0);
  }, 15_000);
});
