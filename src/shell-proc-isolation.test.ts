// Pins the rule that a model-directed shell command cannot reach another unit's
// process files. Secrets are kept safe by LOCALITY, never by filtering what a
// command says: the shell runs as its own uid with ProtectProc=invisible, so
// /proc/<pid>/environ and /proc/<pid>/cmdline of a process that is not its own
// cannot be opened at all. (Steward design S3, acceptance row F10 / row 4.)
//
// Why this exists. Walk goals like "what shells are running?" made the walk write
// `ps aux`, `ps -ef` and `pgrep -f` and run them through shellResult. Every vessel
// runs as root with the default /proc, so the same walk could just as easily have
// written `cat /proc/<pid>/environ`. SurrealDB receives its credentials through an
// EnvironmentFile and the root password on its argv, and a shell result flows into
// the pool, the trace, the judge prompt and the human surface. agent-shell-env.ts
// keeps the vessel's OWN env out of the child; nothing kept OTHER processes' env
// out of reach. A command or path filter cannot close this (the vocabulary of ways
// to name a /proc file is open), which is why the acceptance is an open() outcome.
//
// THE PROBES NEVER READ A BYTE. Each one only opens the file and closes it again,
// and reports opened or refused with the errno class. Nothing from /proc is ever
// read into the shell, its output, this test's output, or a trace. The targets are
// PID 1 (root-owned, never this test's) and a dummy fixture the test spawns itself.
//
// The red tests run the probe THROUGH the vessel's real resolve entry point (the
// same HTTP /resolve the fleet calls, for shellResult and bounded_shell). The child
// shell runs with the test runner's uid and /proc mount, so the verdict is the one
// the lane's shell would get when this suite runs through the shell tool.
//
// Controls that must stay green under any fix:
//  - the test process itself can open the dummy fixture's environ (the instrument
//    can see a visible target);
//  - the shell can open the same-uid fixture's environ (a refusal on PID 1 is the
//    boundary, not a broken probe);
//  - ordinary commands still run and read repo files (a fix that breaks the shell
//    fails here).
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { closeSync, mkdtempSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// index.ts starts a real HTTP server at import time; use a scratch port so this
// never collides with the running vessel (see group-bounded.test.ts).
process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
if (!process.env["WORKSPACE_ROOT"]) process.env["WORKSPACE_ROOT"] = mkdtempSync(join(tmpdir(), "procsec-ws-"));
await import("./index");

const BASE = `http://127.0.0.1:${process.env["PORT"]}`;
const VESSEL_DIR = join(import.meta.dir, "..");

let fixture: ReturnType<typeof Bun.spawn> | null = null;
let fixturePid = 0;

beforeAll(() => {
  const marker = `fx-${Math.random().toString(36).slice(2, 10)}`;
  fixture = Bun.spawn(["sleep", "300"], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", DUMMY_MARKER: marker },
    stdout: "ignore",
    stderr: "ignore",
  });
  fixturePid = fixture.pid;
  // Right after spawn the child may not have exec'd yet; wait (open-only, bounded)
  // until its environ can be opened, so the controls measure the boundary, not a race.
  for (let i = 0; i < 40; i++) {
    try { closeSync(openSync(`/proc/${fixturePid}/environ`, "r")); return; } catch { Bun.sleepSync(50); }
  }
});

afterAll(() => {
  try { fixture?.kill(9); } catch { /* already gone */ }
});

/** Open-and-close probe. Prints PROBE=opened or PROBE=refused:<errno class>. Never reads. */
function openProbe(path: string): string {
  return [
    `e=$( (exec 3<${path}) 2>&1 )`,
    `if [ $? -eq 0 ]; then echo PROBE=opened; else`,
    `case "$e" in *"Permission denied"*) echo PROBE=refused:EACCES;; *"No such file"*) echo PROBE=refused:ENOENT;; *) echo PROBE=refused:OTHER;; esac; fi`,
  ].join("\n");
}

async function viaResolver(type: "shellResult" | "bounded_shell", command: string): Promise<{ stdout: string; exit_code: number }> {
  const res = await fetch(`${BASE}/resolve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ impulse: { pointer: { type, command, cwd: VESSEL_DIR, timeout_sec: 20 } }, timeout: 20 }),
  });
  const body = (await res.json()) as { stdout?: string; exit_code?: number };
  return { stdout: String(body.stdout ?? ""), exit_code: Number(body.exit_code ?? -1) };
}

describe("agent shell cannot open another uid process files", () => {
  it("POSITIVE CONTROL the test process can open the dummy fixture environ without reading it", () => {
    let opened = false;
    try { const fd = openSync(`/proc/${fixturePid}/environ`, "r"); closeSync(fd); opened = true; } catch { opened = false; }
    expect(fixturePid > 0).toBe(true);
    expect(opened).toBe(true);
  });

  for (const type of ["shellResult", "bounded_shell"] as const) {
    it(`CONTROL ${type} opens the same uid dummy fixture environ`, async () => {
      const r = await viaResolver(type, openProbe(`/proc/${fixturePid}/environ`));
      expect(r.stdout.includes("PROBE=opened")).toBe(true);
    }, 30_000);

    it(`CONTROL ${type} still runs an ordinary command and reads a repo file`, async () => {
      const r = await viaResolver(type, `echo ok && head -c 1 package.json && echo && test -e /proc/self/status && echo selfproc`);
      expect(r.exit_code).toBe(0);
      expect(r.stdout.includes("ok")).toBe(true);
      expect(r.stdout.includes("{")).toBe(true);
      expect(r.stdout.includes("selfproc")).toBe(true);
    }, 30_000);

    it(`RED ${type} cannot open environ of pid 1`, async () => {
      const r = await viaResolver(type, openProbe("/proc/1/environ"));
      expect(r.stdout.includes("PROBE=refused")).toBe(true);
      expect(r.stdout.includes("PROBE=opened")).toBe(false);
    }, 30_000);

    it(`RED ${type} cannot open cmdline of pid 1`, async () => {
      const r = await viaResolver(type, openProbe("/proc/1/cmdline"));
      expect(r.stdout.includes("PROBE=refused")).toBe(true);
      expect(r.stdout.includes("PROBE=opened")).toBe(false);
    }, 30_000);
  }
});
