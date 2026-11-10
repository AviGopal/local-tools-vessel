// Pins the rule that an agent-issued shell command cannot reach this vessel's credentials
// through privilege: run as root, the child is nobody with no capabilities, NoNewPrivs, and
// cannot read the parent's environ (shell-privilege.ts). The effect legs need root, which is
// how the vessel runs; as a user they are reported as not judged, and the unchanged-argv leg
// runs instead.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentShellEnv } from "./agent-shell-env";
import { AGENT_SHELL_UID, agentShellSpawn, agentWritableDir, runningAsRoot, SETPRIV_ARGS } from "./shell-privilege";

const root = runningAsRoot();

// Everything the legs make, the homes parent agentShellSpawn makes included, lives under one throwaway
// root that is removed afterwards (rmSync unlinks a symlink, never follows it). 0755, so the shell user
// can reach a HOME inside it, as it can under /tmp.
const TMP = mkdtempSync(join(tmpdir(), "shell-privilege-"));
chmodSync(TMP, 0o755);
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const run = async (cmd: string, cwd?: string) => {
  const s = agentShellSpawn(["bash", "-c", cmd], agentShellEnv(process.env), TMP);
  try {
    const p = Bun.spawn(s.argv, { cwd: cwd ?? "/", env: s.env, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code, home: s.env.HOME };
  } finally { await s.done(); }
};

/** A root-owned 0755 directory: the only kind of parent root hands entries out of. */
const rootOnlyDir = () => { const d = mkdtempSync(join(TMP, "shell-privilege-root-")); chmodSync(d, 0o755); return d; };

describe("agent shell privilege", () => {
  it("both spawn sites in index.ts go through agentShellSpawn", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    expect(src.match(/Bun\.spawn\(\["bash"/g)).toBeNull();
    expect(src.match(/agentShellSpawn\(\["bash", "-c"/g)?.length).toBe(2);
  });

  it("as a user, argv and env are unchanged (the child has no more privilege than its parent)", () => {
    const env = { PATH: "/bin" };
    const s = agentShellSpawn(["bash", "-c", "true"], env, TMP, false);
    expect(s.argv).toEqual(["bash", "-c", "true"]);
    expect(s.env).toBe(env);
  });

  it.if(root)("as root, the command runs under setpriv as the shell user", async () => {
    const s = agentShellSpawn(["bash", "-c", "true"], { PATH: "/bin" }, TMP, true);
    expect(s.argv).toEqual(["setpriv", ...SETPRIV_ARGS, "--", "bash", "-c", "true"]);
    expect(s.env.HOME).not.toBe("/root");
    expect(statSync(s.env.HOME).uid).toBe(AGENT_SHELL_UID);
    expect(s.env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(statSync(s.env.BUN_INSTALL_CACHE_DIR).uid).toBe(AGENT_SHELL_UID);
    await s.done();
    expect(existsSync(s.env.HOME)).toBe(false);
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
    const repo = mkdtempSync(join(TMP, "shell-privilege-repo-"));
    Bun.spawnSync(["chmod", "755", repo]);
    Bun.spawnSync(["git", "init", "-q", repo]);
    const r = await run("git rev-parse --is-inside-work-tree", repo);
    expect(r.err).not.toContain("dubious ownership");
    expect(r.out.trim()).toBe("true");
  });

  it.if(root)("as root, a command cannot turn its HOME into a symlink that root then hands over", async () => {
    const target = rootOnlyDir();
    // The entry sits in a root-only parent: rm can empty it but not remove it, so ln -s can at most
    // make a link INSIDE it, and $HOME itself stays a real directory.
    const r = await run(`rm -rf "$HOME" 2>/dev/null; ln -sfn ${target} "$HOME" 2>/dev/null; [ -L "$HOME" ] && echo PLANTED || echo refused`);
    expect(r.out.trim()).toBe("refused");
    await run("true");
    expect(statSync(target).uid).toBe(0);
  });

  it.if(root)("as root, cleanup does not hold the caller: done() returns before the HOME is emptied", async () => {
    const s = agentShellSpawn(["bash", "-c", "true"], { PATH: "/usr/bin:/bin" }, TMP, true);
    const p = s.done();
    expect(existsSync(s.env.HOME)).toBe(true);
    await p;
    expect(existsSync(s.env.HOME)).toBe(false);
  });

  it.if(root)("as root, bun's install cache is one shared directory, the same for every command", async () => {
    const a = agentShellSpawn(["true"], { PATH: "/bin" }, TMP, true);
    const b = agentShellSpawn(["true"], { PATH: "/bin" }, TMP, true);
    expect(a.env.BUN_INSTALL_CACHE_DIR).toBe(b.env.BUN_INSTALL_CACHE_DIR);
    expect(a.env.BUN_INSTALL_CACHE_DIR.startsWith(a.env.HOME)).toBe(false);
    await Promise.all([a.done(), b.done()]);
    expect(existsSync(a.env.BUN_INSTALL_CACHE_DIR)).toBe(true);
  });

  it.if(root)("as root, each command gets a fresh HOME: nothing one leaves reaches the next", async () => {
    const a = await run(`git config --global core.hooksPath /tmp/planted && echo set`);
    expect(a.out.trim()).toBe("set");
    const b = await run(`git config --global --get core.hooksPath || echo none`);
    expect(b.home).not.toBe(a.home);
    expect(b.out.trim()).toBe("none");
    expect(existsSync(a.home)).toBe(false);
  });

  it.if(root)("as root, a directory is handed to the shell user only out of a root-only parent, never through a symlink", () => {
    expect(() => agentWritableDir(join(mkdtempSync(join(TMP, "shell-privilege-open-")), "x"), true)).not.toThrow(); // mkdtemp: 0700 root
    const open = mkdtempSync(join(TMP, "shell-privilege-open-"));
    chmodSync(open, 0o1777);
    expect(() => agentWritableDir(join(open, "x"), true)).toThrow(/root-only/);
    const parent = rootOnlyDir();
    const target = rootOnlyDir();
    symlinkSync(target, join(parent, "link"));
    expect(() => agentWritableDir(join(parent, "link"), true)).toThrow(/not a real directory/);
    expect(statSync(target).uid).toBe(0);
    const ok = join(parent, "dir");
    mkdirSync(ok);
    expect(statSync(agentWritableDir(ok, true)).uid).toBe(AGENT_SHELL_UID);
  });

  it("code_verify_typecheck's default bun is found on the resolved PATH, not under /root", () => {
    const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
    const line = src.split("\n").find((l) => l.includes('"bun_cmd") ??'));
    expect(line).toBeDefined();
    expect(line).not.toContain("/root");
  });

  it.if(root)("as root, the typecheck command reaches tsc as the shell user", async () => {
    const r = await run("bun run typecheck", join(import.meta.dir, ".."));
    expect([126, 127]).not.toContain(r.code);
    expect(r.err).not.toContain("Permission denied");
    expect(`${r.out}${r.err}`).not.toMatch(/command not found|No such file/);
  });

  it.if(!root)("the effect legs are not judged as a user: run this file as root", () => {
    console.log("shell-privilege: running as a user; the uid, capability and environ legs need root and did not run");
  });
});
