// One [sh-instrument] line per sh() call (sh-instrument.ts). Real processes, real
// /proc: the survivor and pipe-EOF measurements are OS-level properties a mock
// cannot stand in for. The line is captured from console.log, the path the vessel
// actually logs through, so a tree without the instrument fails on "no line".
import { describe, expect, it } from "bun:test";

// index.ts starts a server at import only under import.meta.main, but keep the
// scratch-port guard group-bounded.test.ts uses.
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const { sh } = await import("./index");

const PREFIX = "[sh-instrument] ";

async function shWithLine(...args: Parameters<typeof sh>) {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => {
    const s = a.map(String).join(" ");
    if (s.startsWith(PREFIX)) lines.push(s); else orig(...a);
  };
  let r: Awaited<ReturnType<typeof sh>> | undefined;
  let thrown: unknown;
  try { r = await sh(...args); } catch (e) { thrown = e; } finally { console.log = orig; }
  expect(lines.length).toBe(1);
  return { r, thrown, line: lines[0]!, j: JSON.parse(lines[0]!.slice(PREFIX.length)) };
}

describe("sh() emits exactly one instrument line per call", () => {
  it("a quick command: normal_exit, measured survivors 0, bound and sizes", async () => {
    const { r, j, line } = await shWithLine("echo hi; sleep 0.3", "/tmp", 5);
    expect(r!.stdout).toBe("hi\n");
    expect(j.end_kind).toBe("normal_exit");
    expect(j.exit_code).toBe(0);
    expect(j.effective_timeout_sec).toBe(5);
    expect(j.requested_timeout_sec).toBe(5);
    expect(j.test_class).toBe(false);
    expect(j.slot_wait_ms).toBe(0);
    expect(j.stdout_bytes).toBe(3);
    // Not 0: under groupBounded's `set -m` bash itself writes job notices ("[1]- Done ...")
    // to stderr. That is pre-existing sh() output; the line only counts it.
    expect(j.stderr_bytes).toBe(Buffer.byteLength(r!.stderr));
    expect(j.argv0_base).toBe("echo");
    expect(j.cmd_sha12).toMatch(/^[0-9a-f]{12}$/);
    expect(j.spawn_to_exit_ms).toBeGreaterThanOrEqual(250);
    expect(j.survivors_tracked).toBe(true);
    expect(j.survivors).toBe(0);
    expect(typeof j.watchdog_left).toBe("number");
    console.error(`sample: ${line}`);
  });

  it("reports the clamped bound next to the raw request, and the default when none is given", async () => {
    expect((await shWithLine("true", "/tmp", 2.7)).j).toMatchObject({ effective_timeout_sec: 2, requested_timeout_sec: 2.7 });
    expect((await shWithLine("true", "/tmp")).j).toMatchObject({ effective_timeout_sec: 30, requested_timeout_sec: null });
  });

  it("a command that outlives timeout_sec=2: group_kill (exit 137 at the bound), line still emitted", async () => {
    const { r, j, line } = await shWithLine("sleep 30", "/tmp", 2);
    expect(r!.exit_code).toBe(137);
    expect(j.end_kind).toBe("group_kill");
    expect(j.exit_code).toBe(137);
    expect(j.spawn_to_exit_ms).toBeGreaterThanOrEqual(1750);
    expect(j.spawn_to_exit_ms).toBeLessThan(7000);
    expect(j.survivors).toBe(0);
    console.error(`sample: ${line}`);
  }, 15_000);

  it("positive control: a detached background process is counted, with comm only", async () => {
    const { j } = await shWithLine("sleep 3 >/dev/null 2>&1 & sleep 0.3; echo started", "/tmp", 10);
    expect(j.end_kind).toBe("normal_exit");
    expect(j.survivors_tracked).toBe(true);
    expect(j.survivors).toBeGreaterThanOrEqual(1);
    const p = j.survivor_procs.find((x: { comm: string }) => x.comm === "sleep");
    expect(p).toBeDefined();
    expect(Object.keys(p).sort()).toEqual(["age_s", "comm", "pgid", "pid"]);
    expect(p.age_s).toBeGreaterThanOrEqual(0);
  });

  it("pipe-holder control: an orphan that inherited stdout shows as EOF long after bash exit", async () => {
    const { j } = await shWithLine("sleep 2 & sleep 0.2; echo x", "/tmp", 10);
    expect(j.end_kind).toBe("normal_exit");
    expect(j.spawn_to_eof_ms - j.spawn_to_exit_ms).toBeGreaterThanOrEqual(1500);
  }, 10_000);

  it("a spawn that throws: end_kind error, line emitted, the error still reaches the caller", async () => {
    const { thrown, j } = await shWithLine("true", "/nonexistent-sh-instrument-dir", 5);
    expect(thrown).toBeDefined();
    expect(j.end_kind).toBe("error");
    expect(j.exit_code).toBe(null);
  });
});

describe("the line carries no command text, output or secrets", () => {
  it("a command with a fake token in an env assignment and an Authorization header", async () => {
    const cmd = `T=FAKE_TOKEN_abc123 echo OUT_MARKER_q9; echo ERR_MARKER_q9 >&2; curl -sS -m 2 -H "Authorization: ApiKey FAKE_TOKEN_abc123" http://127.0.0.1:9/ >/dev/null 2>&1 || true`;
    const { r, line, j } = await shWithLine(cmd, "/tmp", 5, { SUBSTRATE_EXECUTION_ID: "exec-test-1" }, "sh-instrument.test");
    expect(r!.stdout).toContain("OUT_MARKER_q9");
    for (const banned of ["FAKE_TOKEN_abc123", "Authorization", "ApiKey", "OUT_MARKER_q9", "ERR_MARKER_q9", "curl -", "127.0.0.1"]) {
      expect(line).not.toContain(banned);
    }
    expect(j.argv0_base).toBe("echo");
    expect(j.execution_id).toBe("exec-test-1");
    expect(j.caller_tag).toBe("sh-instrument.test");
  });

  it("a caller_tag or execution_id that is not a plain identifier is dropped, not logged", async () => {
    const { line, j } = await shWithLine("true", "/tmp", 5, { SUBSTRATE_EXECUTION_ID: "x y FAKE_TOKEN_abc123" }, "tag with spaces FAKE_TOKEN_abc123");
    expect(j.execution_id).toBe(null);
    expect(j.caller_tag).toBe(null);
    expect(line).not.toContain("FAKE_TOKEN_abc123");
  });

  it("argv0_base skips assignments and never returns more than one charset-limited word", async () => {
    const { argv0Base } = await import("./sh-instrument");
    expect(argv0Base("A=1 B=secret /usr/bin/env -i X=y bun test")).toBe("env");
    expect(argv0Base("'/root/.bun/bin/bun' run typecheck")).toBe("bun");
    expect(argv0Base("T=FAKE_TOKEN_abc123")).toBe("?");
    expect(argv0Base("$(cat key) x")).toBe("?");
  });
});

describe("observe-only", () => {
  it("the result is byte-identical with the whole instrument stubbed out, and timing is unchanged", async () => {
    const { shInstrument, NOOP_SH_PROBE } = await import("./sh-instrument");
    const cmd = "printf 'a\\nb'; echo e >&2; exit 3";
    const live = (await shWithLine(cmd, "/tmp", 5)).r;
    const realOpen = shInstrument.open;
    shInstrument.open = () => NOOP_SH_PROBE;
    let stubbed: Awaited<ReturnType<typeof sh>>;
    let tStub: number;
    try {
      stubbed = await sh(cmd, "/tmp", 5);
      const t = Date.now(); await sh("sleep 0.5", "/tmp", 5); tStub = Date.now() - t;
    } finally { shInstrument.open = realOpen; }
    expect(JSON.stringify(live)).toBe(JSON.stringify(stubbed));
    expect(live).toMatchObject({ stdout: "a\nb", exit_code: 3 });
    expect(live!.stderr.startsWith("e\n")).toBe(true);
    const t = Date.now(); await shWithLine("sleep 0.5", "/tmp", 5); const tLive = Date.now() - t;
    expect(Math.abs(tLive - tStub)).toBeLessThan(300);
  });

  it("an instrument that throws never reaches the caller", async () => {
    const { shInstrument } = await import("./sh-instrument");
    const realEmit = shInstrument.emit, realOpen = shInstrument.open;
    try {
      shInstrument.emit = () => { throw new Error("emit boom"); };
      expect(await sh("echo ok", "/tmp", 5)).toMatchObject({ stdout: "ok\n", exit_code: 0 });
      shInstrument.open = () => { throw new Error("open boom"); };
      expect(await sh("echo ok", "/tmp", 5)).toMatchObject({ stdout: "ok\n", exit_code: 0 });
    } finally { shInstrument.emit = realEmit; shInstrument.open = realOpen; }
  });

  it("end_kind inference: early 137 and bash signal deaths are killed_unknown, abort wins", async () => {
    const { inferEndKind } = await import("./sh-instrument");
    const base = { aborted: false, threw: false, signal: null, exitCode: 137, spawnToExitMs: 2000, effectiveTimeoutSec: 2 };
    expect(inferEndKind(base)).toBe("group_kill");
    expect(inferEndKind({ ...base, spawnToExitMs: 500 })).toBe("killed_unknown");
    expect(inferEndKind({ ...base, exitCode: null, signal: "SIGKILL" })).toBe("killed_unknown");
    expect(inferEndKind({ ...base, aborted: true, exitCode: null, signal: "SIGTERM" })).toBe("signal_abort");
    expect(inferEndKind({ ...base, exitCode: 1 })).toBe("normal_exit");
    expect(inferEndKind({ ...base, threw: true, exitCode: null })).toBe("error");
  });
});
