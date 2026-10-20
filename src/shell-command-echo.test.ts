// Pins the 2026-10-20 ruling: a token in a shell command must not come back to the
// caller through bash's job notices on stderr, nor reach the journal through the
// shell handlers' own log lines. The journal half drives the REAL server (src/index.ts
// in a child, as write-containment.test.ts does) and reads everything it prints.
// Controls: the command's own stderr is still returned, a syntax error still reaches
// the caller, the watchdog does not hold the pipe open, and the group kill still kills.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env["PORT"] = String(20000 + Math.floor(Math.random() * 10000));
const { sh } = await import("./index");

const TOKEN = "FAKE_TOKEN_abc123";

describe("returned stderr carries no bash job notices", () => {
  it("MUST-FAIL: a token in the command is not echoed back in stderr", async () => {
    const r = await sh(`true ${TOKEN}; exit 3`, "/tmp", 5);
    expect(r.exit_code).toBe(3);
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toBe("");
  });

  it("nor when the watchdog kills it (no 'Killed ( <command> )' line), and the kill still lands", async () => {
    const r = await sh(`sleep 30 # ${TOKEN}\n`, "/tmp", 1);
    expect(r.exit_code).toBe(137);
    expect(r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toBe("");
  }, 10_000);

  it("CONTROL: the command's own stderr is still returned, in order", async () => {
    // Holds on both trees: the command's own lines lead stderr, in order (before the fix,
    // bash's notice line followed them).
    expect((await sh("echo err >&2", "/tmp", 5)).stderr.startsWith("err\n")).toBe(true);
    const r = await sh("echo a >&2; echo b; echo c >&2", "/tmp", 5);
    expect(r).toMatchObject({ stdout: "b\n", exit_code: 0 });
    expect(r.stderr.startsWith("a\nc\n")).toBe(true);
  });

  it("CONTROL: a syntax error in the command still reaches the caller", async () => {
    const r = await sh("echo (", "/tmp", 5);
    expect(r.exit_code).toBe(2);
    expect(r.stderr).toContain("syntax error");
  });

  it("CONTROL: the kept stderr fd is not visible to the command, and the watchdog does not hold the pipe", async () => {
    const t = Date.now();
    const r = await sh("[ -e /proc/self/fd/3 ] && echo fd3-open || echo fd3-closed", "/tmp", 20);
    expect(r.stdout).toBe("fd3-closed\n");
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe("the shell handlers' journal lines carry no command text", () => {
  let base = "", superRepo = "", url = "";
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let printed: Promise<string> = Promise.resolve("");

  beforeAll(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "shell-echo-")));
    superRepo = join(base, "super-repo");
    execFileSync("git", ["init", "-q", superRepo]);
    const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    child = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: base, PORT: String(port),
        WORKSPACE_ROOT: base, SUPER_REPO_DIR: superRepo, MITOSIS_RUNTIME_DIR: join(base, "vessels"),
        DISCOVERY_ENDPOINT: "http://127.0.0.1:9", LOCAL_TOOLS_GC_INTERVAL_MS: "600000",
      },
      stdout: "pipe", stderr: "pipe",
    });
    printed = Promise.all([new Response(child.stdout as ReadableStream).text(), new Response(child.stderr as ReadableStream).text()]).then(([o, e]) => o + e);
    url = `http://127.0.0.1:${port}/resolve`;
    let up = false;
    for (let i = 0; i < 250 && !up; i++) {
      try { up = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not up yet */ }
      if (!up) await Bun.sleep(100);
    }
    if (!up) throw new Error(`local-tools server never became healthy on port ${port}`);
  }, 30_000);

  afterAll(() => { child?.kill(); rmSync(base, { recursive: true, force: true }); });

  const call = async (pointer: Record<string, unknown>) =>
    (await (await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ impulse: { pointer: { type: "shell", ...pointer } } }) })).json()) as Record<string, unknown>;

  it("MUST-FAIL: no line the server prints contains the token (request without execution_id, and a refusal)", async () => {
    const ran = await call({ command: `true ${TOKEN}; exit 3`, cwd: "/tmp" });
    expect(ran.exit_code).toBe(3);
    expect(String(ran.stderr)).not.toContain(TOKEN);
    const refused = await call({ command: `echo ${TOKEN} > leak.txt`, cwd: superRepo });
    expect(refused.error).toBeDefined();
    child!.kill();
    const out = await printed;
    // The lines were really emitted (so their absence of the token is measured, not vacuous)...
    expect(out).toContain("[local-tools] shell request WITHOUT execution_id");
    expect(out).toContain("[local-tools] shell write refused");
    expect(out).toMatch(/WITHOUT execution_id .*cmd_sha12=[0-9a-f]{12} argv0_base=true/);
    expect(out).toMatch(/refused .*\(cmd_sha12=[0-9a-f]{12} argv0_base=echo\)/);
    // ...and none of them carries the command text. (The refusal reason still names its
    // resolved write target, a path, as it always has; that is a diagnostic, not the command.)
    expect(out).not.toContain(TOKEN);
  }, 20_000);
});
