// The shells (sh, under `shell`/`bash`, and bounded_shell) answer once the command ends, whatever it leaves running.
// They are the walk's main tools, and a command often starts something in the background (`npm run dev &`, a watcher,
// a `sleep`), sometimes in a session of its own (setsid). Each kept the command's stdout or stderr, and the call waited
// for it to the backstop, or forever; with discovery holding local-tools' calls with no limit, one such job parked the
// walk. Judged by effect: how long the answer takes, and what it says.
import { describe, expect, test } from "bun:test";

process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const { sh, resolvers } = await import("./index");
const SLACK_MS = 10_000;
const bounded = (command: string, timeout_sec: number) =>
  resolvers.get("bounded_shell")!({ body: { impulse: { pointer: { command, timeout_sec, cwd: "/tmp" } } } } as never) as Promise<{ stdout?: string; exit_code?: number; error?: string }>;

describe("a shell answers once its command ends, whatever it leaves running", () => {
  test("[MUST-FAIL] sh: a job left in the background does not hold the answer", async () => {
    const t0 = Date.now();
    const r = await sh("sleep 60 & echo hi", "/tmp", 3);
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.stdout).toBe("hi\n");
  }, 30_000);

  test("[MUST-FAIL] sh: nor one in a session of its own (setsid)", async () => {
    const t0 = Date.now();
    const r = await sh("setsid sh -c 'sleep 60 >&2' & echo hi", "/tmp", 3);
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.stdout).toBe("hi\n");
  }, 30_000);

  test("[MUST-FAIL] bounded_shell: a job left in the background does not hold the answer", async () => {
    const t0 = Date.now();
    const r = await bounded("sleep 60 & echo hi", 3);
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.stdout).toBe("hi\n");
  }, 30_000);

  test("[MUST-FAIL] bounded_shell: nor one in a session of its own (setsid)", async () => {
    const t0 = Date.now();
    const r = await bounded("setsid sh -c 'sleep 60 >&2' & echo hi", 3);
    expect(Date.now() - t0).toBeLessThan(SLACK_MS);
    expect(r.stdout).toBe("hi\n");
  }, 30_000);
});
