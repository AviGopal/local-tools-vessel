// git_commit commits in a worktree made for the change, checked by the base's hooks, without this vessel's credentials
// and without a shell. Each case runs against a throwaway origin, clone and worktree.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInWorktree } from "./git-commit";

const T = mkdtempSync(join(tmpdir(), "git-commit-test-"));
const PAT = "pat-value-that-must-not-reach-a-hook";
const savedPat = process.env.GITHUB_PUSH_TOKEN;
const env = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// The base's hook: refuses while a BLOCK file is committed, and records the env it ran with.
const HOOK = "#!/bin/sh\nenv > \"$(git rev-parse --show-toplevel)/../hook-env.txt\"\n[ -e BLOCK ] && { echo blocked >&2; exit 1; }\nexit 0\n";

let n = 0;
// A fresh worktree tracking origin/dev in a clone whose hooks are .git-hooks, as install.sh sets them.
const worktree = (): { clone: string; wt: string } => {
  n++;
  const clone = join(T, `clone-${n}`);
  g(T, "clone", "-q", "-b", "dev", join(T, "origin.git"), clone);
  g(clone, "config", "core.hooksPath", ".git-hooks");
  g(clone, "config", "user.name", "t"); g(clone, "config", "user.email", "t@t");
  const wt = join(T, `wt-${n}`);
  g(clone, "worktree", "add", "-q", "--track", "-b", `change-${n}`, wt, "origin/dev");
  return { clone, wt };
};

beforeAll(() => {
  process.env.GITHUB_PUSH_TOKEN = PAT;
  for (const [k, v] of Object.entries(env)) if (k.startsWith("GIT_")) process.env[k] = v;
  g(T, "init", "-q", "--bare", "-b", "dev", "origin.git");
  const seed = join(T, "seed");
  g(T, "clone", "-q", join(T, "origin.git"), seed);
  mkdirSync(join(seed, ".git-hooks"));
  writeFileSync(join(seed, ".git-hooks", "pre-commit"), HOOK, { mode: 0o755 });
  writeFileSync(join(seed, "a.txt"), "one\n");
  g(seed, "add", "-A"); g(seed, "commit", "-q", "-m", "base"); g(seed, "push", "-q", "origin", "HEAD:dev");
});
afterAll(() => {
  if (savedPat === undefined) delete process.env.GITHUB_PUSH_TOKEN; else process.env.GITHUB_PUSH_TOKEN = savedPat;
  rmSync(T, { recursive: true, force: true });
});

describe("git_commit", () => {
  it("[MUST-FAIL] commits a message as written: $(...) and backticks are never run", async () => {
    const { wt } = worktree();
    writeFileSync(join(wt, "a.txt"), "two\n");
    const message = "fix: say $(touch PWNED) and `touch PWNED2`";
    const r = await commitInWorktree(wt, message);
    expect("sha" in r).toBe(true);
    expect(g(wt, "log", "-1", "--format=%B")).toBe(message);
    expect(existsSync(join(wt, "PWNED")) || existsSync(join(wt, "PWNED2")) || existsSync(join(T, "PWNED"))).toBe(false);
  });

  it("[MUST-FAIL] runs the base's hooks, not the worktree's: a hook weakened in the change does not run", async () => {
    const { wt } = worktree();
    writeFileSync(join(wt, ".git-hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(join(wt, "BLOCK"), "x\n");
    const r = await commitInWorktree(wt, "weaken the gate");
    expect("error" in r && r.error).toContain("refused");
    expect("stderr" in r && r.stderr).toContain("blocked");
  });

  it("[MUST-FAIL] the commit and its hooks run without this vessel's credentials", async () => {
    const { wt } = worktree();
    writeFileSync(join(wt, "a.txt"), "three\n");
    const r = await commitInWorktree(wt, "an ordinary change");
    expect("sha" in r).toBe(true);
    const seen = readFileSync(join(wt, "..", "hook-env.txt"), "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).not.toContain(PAT);
    expect(seen).not.toContain("GITHUB_PUSH_TOKEN");
  });

  it("[MUST-FAIL] refuses a main clone: it commits only in a worktree made for the change", async () => {
    const { clone } = worktree();
    writeFileSync(join(clone, "a.txt"), "four\n");
    const r = await commitInWorktree(clone, "straight into the clone");
    expect("error" in r && r.error).toContain("not a worktree");
    expect(g(clone, "log", "-1", "--format=%s")).toBe("base");
  });

  it("marks a change to what judges changes as needing a person, and says what changed", async () => {
    const { wt } = worktree();
    mkdirSync(join(wt, "scripts", "substrate", "gate"), { recursive: true });
    writeFileSync(join(wt, "scripts", "substrate", "gate", "x.sh"), "x\n");
    writeFileSync(join(wt, "a.txt"), "five\n");
    const r = await commitInWorktree(wt, "touch the gate");
    if (!("sha" in r)) throw new Error(JSON.stringify(r));
    expect(r.changed.sort()).toEqual(["a.txt", "scripts/substrate/gate/x.sh"]);
    expect(r.needs_person).toEqual(["scripts/substrate/gate/x.sh"]);
    expect(r.tree).toBe(g(wt, "rev-parse", "HEAD^{tree}"));
    expect(r.base).toBe(g(wt, "rev-parse", "origin/dev"));
  });

  it("refuses a worktree with nothing changed", async () => {
    const { wt } = worktree();
    const r = await commitInWorktree(wt, "nothing");
    expect("error" in r && r.error).toContain("nothing to commit");
  });
});
