// Pins the rule that an agent-issued shell command cannot reach this vessel's credentials
// through privilege: run as root, the child is nobody with no capabilities, NoNewPrivs, and
// cannot read the parent's environ (shell-privilege.ts). The effect legs need root, which is
// how the vessel runs; as a user they are reported as not judged, and the unchanged-argv leg
// runs instead.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentShellEnv } from "./agent-shell-env";
import { AGENT_SHELL_UID, agentShellSpawn, runningAsRoot, SETPRIV_ARGS } from "./shell-privilege";

const root = runningAsRoot();

const run = async (cmd: string, cwd?: string) => {
  const tmp = mkdtempSync(join(tmpdir(), "shell-privilege-"));
  const s = agentShellSpawn(["bash", "-c", cmd], agentShellEnv(process.env), tmp);
  const p = Bun.spawn(s.argv, { cwd: cwd ?? "/", env: s.env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { out, err, code };
};

describe("agent shell privilege", () => {
  it("both spawn sites in index.ts go through agentShellSpawn", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src.match(/Bun\.spawn\(\["bash"/g)).toBeNull();
    expect(src.match(/agentShellSpawn\(\["bash", "-c"/g)?.length).toBe(2);
  });

  it("as a user, argv and env are unchanged (the child has no more privilege than its parent)", () => {
    const env = { PATH: "/bin" };
    expect(agentShellSpawn(["bash", "-c", "true"], env, tmpdir(), false)).toEqual({ argv: ["bash", "-c", "true"], env });
  });

  it.if(root)("as root, the command runs under setpriv as the shell user", () => {
    const s = agentShellSpawn(["bash", "-c", "true"], { PATH: "/bin" }, mkdtempSync(join(tmpdir(), "shell-privilege-")), true);
    expect(s.argv).toEqual(["setpriv", ...SETPRIV_ARGS, "--", "bash", "-c", "true"]);
    expect(s.env.HOME).not.toBe("/root");
    expect(s.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
  });

  it.if(root)("as root, the child is not root, holds no capabilities and sets NoNewPrivs", async () => {
    const r = await run("id -u; grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs):' /proc/self/status");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(Number(lines[0])).toBe(AGENT_SHELL_UID);
    expect(r.out).toMatch(/CapEff:\s+0+\n/);
    expect(r.out).toMatch(/CapPrm:\s+0+\n/);
    expect(r.out).toMatch(/CapBnd:\s+0+\n/);
    expect(r.out).toMatch(/NoNewPrivs:\s+1/);
  });

  it.if(root)("as root, the child cannot read its parent's environ", async () => {
    const r = await run(`test -r /proc/${process.pid}/environ && echo READABLE || echo unreadable`);
    expect(r.out.trim()).toBe("unreadable");
  });

  it.if(root)("as root, the child can still read and run git in a repo root owns", async () => {
    const repo = mkdtempSync(join(tmpdir(), "shell-privilege-repo-"));
    Bun.spawnSync(["chmod", "755", repo]);
    Bun.spawnSync(["git", "init", "-q", repo]);
    const r = await run("git rev-parse --is-inside-work-tree", repo);
    expect(r.err).not.toContain("dubious ownership");
    expect(r.out.trim()).toBe("true");
  });

  it.if(!root)("the effect legs are not judged as a user: run this file as root", () => {
    console.log("shell-privilege: running as a user; the uid, capability and environ legs need root and did not run");
  });
});
