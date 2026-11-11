// git_worktree makes a clone for one change; git_commit commits in it only when the walk's row says git_worktree made
// it, checked by the super-repo's hooks as of that making, without this vessel's credentials and without a shell.
// Everything runs against throwaway repositories; records is a stub answering the walk's rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone } from "./git-commit";
import { makeWorktree } from "./git-worktree";
import { madeClone, type Made } from "./walk-rows";

const T = mkdtempSync(join(tmpdir(), "git-commit-test-"));
const PAT = "pat-value-that-must-not-reach-a-hook";
const ENV_KEYS = ["DISCOVERY_ENDPOINT", "GITHUB_PUSH_TOKEN", "SUPER_REPO_DIR", "MITOSIS_PUSH_CLONE_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };

// Each hook records which one ran and the env it ran with, and refuses while a BLOCK file is in the change.
const hook = (name: string, extra = "") =>
  `#!/bin/sh\necho ${name} >> "${T}/hooks-ran.txt"\nenv > "${T}/hook-env.txt"\n${extra}[ -e BLOCK ] && { echo blocked >&2; exit 1; }\nexit 0\n`;
const SUPER = join(T, "super");
const CLONES = join(T, "clones");

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: `0 walk rows record a clone made at ${cwd}` };
const clone = async (repo: string): Promise<string> => {
  const w = await makeWorktree(repo);
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  return w.cwd;
};

beforeAll(() => {
  Object.assign(process.env, { DISCOVERY_ENDPOINT: "http://discovery.test", GITHUB_PUSH_TOKEN: PAT, SUPER_REPO_DIR: SUPER, MITOSIS_PUSH_CLONE_DIR: CLONES, WALK_TREES_DIR: join(T, "trees") });
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  writeFileSync(join(SUPER, "scripts", "git-hooks", "pre-commit"), hook("super-hook"), { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", "vessel-pre-commit"), hook("vessel-hook", "echo 'note: gitleaks not installed; secrets scan skipped.'\n"), { mode: 0o755 });
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");
  const demo = join(CLONES, "demo");
  mkdirSync(demo, { recursive: true });
  g(demo, "init", "-q", "-b", "dev");
  writeFileSync(join(demo, "a.txt"), "one\n");
  g(demo, "remote", "add", "origin", "https://example.invalid/demo.git");
  commitAll(demo, "demo base");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  globalThis.fetch = realFetch;
  rmSync(T, { recursive: true, force: true });
});

describe("git_worktree", () => {
  it("clones this node's copy for one change, at its HEAD, with that copy's origin", async () => {
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    expect(w.cwd.startsWith(join(T, "trees"))).toBe(true);
    expect(w.base).toBe(g(join(CLONES, "demo"), "rev-parse", "HEAD"));
    expect(w.super_base).toBe(g(SUPER, "rev-parse", "HEAD"));
    expect(w.origin_url).toBe("https://example.invalid/demo.git");
    expect(w.branch).toBe("dev");
    expect(g(w.cwd, "config", "--get", "remote.origin.url")).toBe("https://example.invalid/demo.git");
    expect(readFileSync(join(w.cwd, "a.txt"), "utf8")).toBe("one\n");
  });

  it("refuses a name that is not a repo's, and a repo this node has no copy of", async () => {
    expect("error" in (await makeWorktree("../etc"))).toBe(true);
    expect(String((await makeWorktree("no-such-vessel") as { error: string }).error)).toContain("no copy");
  });
});

describe("git_commit", () => {
  it("[MUST-FAIL] commits a message as written: $(...) and backticks are never run", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "two\n");
    const message = "fix: say $(touch PWNED) and `touch PWNED2`";
    const r = await commitInClone(cwd, message, undefined, find);
    expect("sha" in r).toBe(true);
    expect(g(cwd, "log", "-1", "--format=%B")).toBe(message);
    expect(existsSync(join(cwd, "PWNED")) || existsSync(join(cwd, "PWNED2")) || existsSync(join(T, "PWNED"))).toBe(false);
  });

  it("[MUST-FAIL] runs the super-repo's hook, not one the change sets up: a weakened hook in the clone does not run", async () => {
    const cwd = await clone("demo");
    mkdirSync(join(cwd, ".git-hooks"));
    writeFileSync(join(cwd, ".git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    g(cwd, "config", "core.hooksPath", ".git-hooks");
    writeFileSync(join(cwd, "BLOCK"), "x\n");
    const r = await commitInClone(cwd, "weaken the gate", undefined, find);
    expect("error" in r && r.error).toContain("refused");
    expect("stderr" in r && r.stderr).toContain("blocked");
  });

  it("[MUST-FAIL] the commit and its hook run without this vessel's credentials", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "three\n");
    expect("sha" in (await commitInClone(cwd, "an ordinary change", undefined, find))).toBe(true);
    const seen = readFileSync(join(T, "hook-env.txt"), "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).not.toContain(PAT);
    expect(seen).not.toContain("GITHUB_PUSH_TOKEN");
  });

  it("[MUST-FAIL] takes the base from the walk's row: a commit slipped into the clone is still judged", async () => {
    const cwd = await clone("demo");
    mkdirSync(join(cwd, "scripts", "substrate", "gate"), { recursive: true });
    writeFileSync(join(cwd, "scripts", "substrate", "gate", "x.sh"), "x\n");
    commitAll(cwd, "slipped in by hand"); // the clone's own HEAD now carries the gate change
    writeFileSync(join(cwd, "a.txt"), "four\n");
    const r = await commitInClone(cwd, "an ordinary-looking change", undefined, find);
    if (!("sha" in r)) throw new Error(JSON.stringify(r));
    expect(r.base).toBe(made.get(cwd)!.base);
    expect(r.changed.sort()).toEqual(["a.txt", "scripts/substrate/gate/x.sh"]);
    expect(r.needs_person).toEqual(["scripts/substrate/gate/x.sh"]);
    expect(r.tree).toBe(g(cwd, "rev-parse", "HEAD^{tree}"));
  });

  it("[MUST-FAIL] a clone the walk's rows do not name exactly once, or that has landed, is refused", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "five\n");
    const row = (id: string, pointer_type: string, output: object) => ({ id, role: "walk", shape: "hop", phase: "ended", pointer_type, output });
    const answer = (byType: Record<string, unknown[]>) => {
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
        const p = JSON.parse(String(init?.body)).pointer;
        return Response.json(byType[p.where.pointer_type] ?? []);
      }) as typeof fetch;
    };
    const w = made.get(cwd)!;
    answer({ git_worktree: [] });
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("0 walk rows");
    answer({ git_worktree: [row("h1", "git_worktree", w), row("h2", "git_worktree", w)] });
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("2 walk rows");
    answer({ git_worktree: [{ ...row("h1", "git_worktree", w), role: "person" }] });
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("0 walk rows");
    answer({ git_worktree: [row("h1", "git_worktree", w)], git_land: [row("h3", "git_land", { cwd })] });
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("already landed");
    delete process.env.DISCOVERY_ENDPOINT;
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no discovery endpoint");
    process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
    answer({ git_worktree: [row("h1", "git_worktree", w)] });
    expect(await madeClone(cwd)).toEqual({ cwd, repo: "demo", branch: "dev", base: w.base, super_base: w.super_base, origin_url: w.origin_url });
    globalThis.fetch = realFetch;
    expect(String((await commitInClone(join(T, "not-made"), "x", undefined, find) as { error: string }).error)).toContain("0 walk rows");
  });

  it("a vessel change runs the vessel hook and a super-repo change the super hook; a skipped secrets scan is reported", async () => {
    const before = existsSync(join(T, "hooks-ran.txt")) ? readFileSync(join(T, "hooks-ran.txt"), "utf8").split("\n").length : 1;
    const v = await clone("demo");
    writeFileSync(join(v, "a.txt"), "six\n");
    const rv = await commitInClone(v, "vessel change", undefined, find);
    const s = await clone("super");
    writeFileSync(join(s, "README.md"), "x\n");
    const rs = await commitInClone(s, "super change", undefined, find);
    const ran = readFileSync(join(T, "hooks-ran.txt"), "utf8").split("\n").slice(before - 1).filter(Boolean);
    expect(ran).toEqual(["vessel-hook", "super-hook"]);
    expect("scan" in rv && rv.scan).toBe("skipped");
    expect("scan" in rs && rs.scan).toBe("ran");
  });

  it("[MUST-FAIL] keeps the node's record-only hooks, but never its pre-commit, which would chain to the clone's own", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "ledger-hooks-"));
    writeFileSync(join(ledger, "post-commit"), `#!/bin/sh\necho recorded >> "${T}/ledger.txt"\n`, { mode: 0o755 });
    writeFileSync(join(ledger, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const sys = join(T, "gitconfig-system");
    writeFileSync(sys, `[core]\n\thooksPath = ${ledger}\n`);
    const keep = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
    try {
      const cwd = await clone("demo");
      writeFileSync(join(cwd, "a.txt"), "eight\n");
      expect("sha" in (await commitInClone(cwd, "recorded", undefined, find))).toBe(true);
      expect(readFileSync(join(T, "ledger.txt"), "utf8")).toContain("recorded");
      writeFileSync(join(cwd, "BLOCK"), "x\n"); // the ledger's permissive pre-commit must not replace the super-repo's
      expect("error" in (await commitInClone(cwd, "blocked", undefined, find))).toBe(true);
    } finally {
      if (keep === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = keep;
      rmSync(ledger, { recursive: true, force: true });
    }
  });

  it("leaves no pinned hook directory behind, and refuses a clone with nothing changed", async () => {
    const pinned = () => readdirSync(tmpdir()).filter((n) => n.startsWith("pinned-hooks-")).length;
    const before = pinned();
    const cwd = await clone("demo");
    expect(String((await commitInClone(cwd, "nothing", undefined, find) as { error: string }).error)).toContain("nothing to commit");
    writeFileSync(join(cwd, "a.txt"), "seven\n");
    await commitInClone(cwd, "something", undefined, find);
    expect(pinned()).toBe(before);
  });
});
