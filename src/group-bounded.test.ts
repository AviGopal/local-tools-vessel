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

// index.ts starts a REAL HTTP server unconditionally at import time (no
// import.meta.main gate). Running inside this same live container, the real
// default port 8230 is already bound by the actual running vessel — set to a
// scratch port before importing so this test doesn't collide with it (the
// same reason map-path.test.ts's own header documents needing a hermetic
// WORKSPACE_ROOT: module-load-time side effects must be set up before import).
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const { sh, groupBounded } = await import("./index");

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

  it("groupBounded's generated script defines a recursive killtree function", () => {
    const script = groupBounded("sleep 100", 5);
    expect(script).toContain("__killtree");
    expect(script).toMatch(/kill -9 "?\$__t"?/);
    // The original group-kill stays as a backstop.
    expect(script).toContain("kill -9 -$__cpid");
  });
});
