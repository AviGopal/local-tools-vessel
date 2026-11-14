// A step that runs the walk's tree (git_diff's typecheck, the gap's test file) answers within its bound, whatever the
// tree starts: asShellUser runs it in its own process group, kills the group at the bound, and does not wait on its
// pipes past it. Killing the command alone was not enough: a process it started that kept the command's stdout (a
// server, a watcher, a `sleep` left running) held the read open past the bound, and forever if it never ended, and with
// discovery holding local-tools' calls with no limit the walk would have waited on that answer forever.
// Judged by effect: how long the answer takes, and whether what was started is still alive.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asShellUser } from "./git-land.js";

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dir = () => mkdtempSync(join(tmpdir(), "step-bound-"));
const pidOf = (d: string): number => Number(readFileSync(join(d, "pid"), "utf8").trim());

describe("a step answers within its bound, whatever it starts", () => {
  test("[MUST-FAIL] a command that leaves a process holding its stdout answers at the bound, says so, and leaves it dead", async () => {
    const d = dir();
    const t0 = Date.now();
    const r = await asShellUser(["sh", "-c", "sleep 600 & echo $! > pid; echo started; wait"], d, 1500);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(1500 + 4000);
    expect(r.killed).toBe(true);
    expect(r.signalled).toBe(true);
    expect(r.out).toContain("started");
    expect(r.out).toContain("killed at the step bound");
    expect(alive(pidOf(d))).toBe(false);
  }, 15_000);

  test("[MUST-FAIL] a command that ends but leaves a process holding its pipes answers soon after it ends, not at the bound", async () => {
    const d = dir();
    const t0 = Date.now();
    const r = await asShellUser(["sh", "-c", "(sleep 600 & echo $! > pid); echo done"], d, 60_000);
    const took = Date.now() - t0;
    expect(took).toBeLessThan(6000);
    expect(r.out).toContain("done");
    expect(r.killed).toBe(false);
    expect(r.exit_code).toBe(0);
    expect(alive(pidOf(d))).toBe(false);
  }, 15_000);

  test("a command still running at the bound is killed there (a guard: killing the command alone does this too)", async () => {
    const t0 = Date.now();
    const r = await asShellUser(["sh", "-c", "echo before; sleep 600"], dir(), 1000);
    expect(Date.now() - t0).toBeLessThan(1000 + 4000);
    expect(r.killed).toBe(true);
    expect(r.out).toContain("before");
  }, 15_000);

  test("a command that ends answers at once with its output and exit code, not killed (a guard)", async () => {
    const t0 = Date.now();
    const r = await asShellUser(["sh", "-c", "echo out; echo err >&2; exit 3"], dir(), 60_000);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r).toMatchObject({ exit_code: 3, killed: false, signalled: false });
    expect(r.out).toContain("out");
    expect(r.out).toContain("err");
  });
});
