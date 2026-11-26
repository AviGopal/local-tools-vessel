// SPDX-License-Identifier: MIT
// A walk clone git could not read is said as that, with git's exit and the class of what it wrote, never as a clone off
// its branch or behind its copy (which are what git answered), and with no way on. Throwaway repositories.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behind, cloneOf, refusalOf } from "./clone-freshness";
import { freshFirst, refreshInPlace } from "./clone-refresh";
import { movedOnAnswer, refreshed, unreadOf } from "./git-worktree";

const T = mkdtempSync(join(tmpdir(), "clone-unread-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const env = { MITOSIS_PUSH_CLONE_DIR: join(T, "vessels"), WALK_TREES_DIR: join(T, "trees"), SUPER_REPO_DIR: join(T, "super") };
const copy = join(T, "vessels", "demo-vessel");
mkdirSync(copy, { recursive: true }); mkdirSync(join(T, "trees")); mkdirSync(env.SUPER_REPO_DIR);
g(env.SUPER_REPO_DIR, "init", "-q", "-b", "dev"); g(env.SUPER_REPO_DIR, "commit", "-q", "--allow-empty", "-m", "super");
g(copy, "init", "-q", "-b", "dev"); writeFileSync(join(copy, "a.ts"), "1\n"); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "base");
let n = 0;
/** A clone of the copy as it is now, on its own walk/ branch. */
const fresh = () => {
  const name = `demo-vessel-mwunread-${(++n).toString().padStart(8, "0")}`;
  const dir = join(T, "trees", name);
  g(T, "clone", "-q", copy, dir); g(dir, "checkout", "-q", "-b", `walk/${name}`);
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", dir]);
  return dir;
};
/** A clone git cannot read: its HEAD is not a ref or a commit. */
const unreadable = () => { const dir = fresh(); writeFileSync(join(dir, ".git", "HEAD"), "not a head\n"); return dir; };
const head = () => g(copy, "rev-parse", "HEAD");

describe("what git answered, apart from git not answering", () => {
  it("[MUST-FAIL] a failed git's class comes from what it wrote, with its exit", () => {
    const of = (stderr: string, exit_code = 128) => unreadOf({ exit_code, stderr });
    expect(of("x\n[killed at the step bound (60000 ms): the command, or something it started, was still running]", 137))
      .toEqual({ exit_code: 137, stderr_class: "timeout" });
    expect(of("fatal: detected dubious ownership in repository at '/x'").stderr_class).toBe("dubious_ownership");
    expect(of("fatal: not a git repository (or any parent up to mount point /)").stderr_class).toBe("not_a_repository");
    expect(of("fatal: Unable to create '/x/.git/index.lock': File exists.").stderr_class).toBe("lock");
    expect(of("error: cannot open .git/FETCH_HEAD: Permission denied").stderr_class).toBe("permission");
    expect(of("fatal: something else", 2)).toEqual({ exit_code: 2, stderr_class: "other" });
  });
  it("[MUST-FAIL] only not-under-HEAD (exit 1) and the copy's own commit missing are answers that the copy moved on", () => {
    expect(movedOnAnswer({ exit_code: 1, stderr: "" }, "1234")).toBe(true);
    expect(movedOnAnswer({ exit_code: 128, stderr: "fatal: Not a valid commit name 1234" }, "1234")).toBe(true);
    expect(movedOnAnswer({ exit_code: 128, stderr: "fatal: Not a valid commit name HEAD" }, "1234")).toBe(false);
    expect(movedOnAnswer({ exit_code: 128, stderr: "fatal: not a git repository" }, "1234")).toBe(false);
    expect(movedOnAnswer({ exit_code: 137, stderr: "[killed at the step bound (60000 ms)]" }, "1234")).toBe(false);
    expect(movedOnAnswer({ exit_code: 2, stderr: "fatal: Not a valid commit name 1234" }, "1234")).toBe(false);
  });
});

describe("refreshed(): a clone git could not read", () => {
  it("[MUST-FAIL] is said as could not be read, with the exit and class, not as off its branch, and claims nothing it holds", async () => {
    const dir = unreadable();
    const r = await refreshed(dir, head(), head(), "dev", copy);
    expect(r).toEqual({ ok: false, conflicts: [], why: "the clone could not be read", unread: { exit_code: 128, stderr_class: "not_a_repository" } });
  });
  it("[MUST-FAIL] a clone whose HEAD reads but whose status does not (a corrupt index) is said as could not be read", async () => {
    const dir = fresh();
    writeFileSync(join(dir, ".git", "index"), "junk\n");
    const r = await refreshed(dir, head(), head(), "dev", copy);
    expect(r).toEqual({ ok: false, conflicts: [], why: "the clone could not be read", unread: { exit_code: 128, stderr_class: "other" } });
  });
  it("[GUARD] a clone off its walk/ branch (a detached HEAD) keeps its words", async () => {
    const dir = fresh();
    g(dir, "checkout", "-q", "--detach");
    const r = await refreshed(dir, head(), head(), "dev", copy);
    expect(r).toMatchObject({ ok: false, why: "the clone is not on its own walk/ branch", changed: false });
    expect("unread" in r).toBe(false);
  });
});

describe("behind(): a clone git could not read", () => {
  it("[MUST-FAIL] is said as could not be read, with no way on, and not as a clone the copy moved past", async () => {
    const dir = unreadable();
    const why = await behind({ dir, repo: "demo-vessel" }, env);
    expect(why).toEqual({ clone_unread: { cwd: dir, exit_code: 128, stderr_class: "not_a_repository" } });
  });
  it("[MUST-FAIL] a clone missing its own HEAD's commit is one git could not read, not one the copy moved past", async () => {
    const dir = fresh();
    g(dir, "commit", "-q", "--allow-empty", "-m", "the clone's own");
    const own = g(dir, "rev-parse", "HEAD");
    rmSync(join(dir, ".git", "objects", own.slice(0, 2), own.slice(2)), { force: true });
    expect(await behind({ dir, repo: "demo-vessel" }, env)).toEqual({ clone_unread: { cwd: dir, exit_code: 128, stderr_class: "other" } });
  });
  it("[GUARD] a clone the copy moved past keeps its words: a commit it lacks, and one it holds but not under HEAD", async () => {
    const lacks = fresh();
    const off = fresh();
    writeFileSync(join(copy, "b.ts"), `${n}\n`); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "a push, installed");
    const a = await behind({ dir: lacks, repo: "demo-vessel" }, env);
    expect(a).toContain(`moved on (to ${head().slice(0, 10)})`);
    expect(a).toContain("for a fresh clone");
    g(off, "fetch", "-q", copy, "dev");
    const b = await behind({ dir: off, repo: "demo-vessel" }, env);
    expect(b).toContain(`moved on (to ${head().slice(0, 10)})`);
  });
  it("[MUST-FAIL] after a refresh that could not read the clone, a copy that moved on is said with no way on", async () => {
    const dir = fresh();
    writeFileSync(join(copy, "c.ts"), `${n}\n`); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "another push");
    const refusal = refusalOf({ error: `${dir} could not be read`, conflicts: [], unread: { exit_code: 137, stderr_class: "timeout" } });
    expect(refusal).toEqual({ conflicts: [], held: null, unread: true });
    expect(await behind({ dir, repo: "demo-vessel" }, env, refusal))
      .toBe(`${dir} was made before this node's copy of demo-vessel moved on (to ${head().slice(0, 10)})`);
  });
});

describe("a tool's answer about a path in a clone git could not read", () => {
  it("[MUST-FAIL] leads with clone_unread and carries no clone_behind and no way on", async () => {
    Object.assign(process.env, env);
    const { wrapped } = await import("./index");
    const dir = unreadable();
    const ctx = { body: { impulse: { pointer: { path: join(dir, "a.ts") } } } } as never;
    const out = (await wrapped("fs_read", (async () => ({ shape: "fileContent" })) as never, async () => null)(ctx)) as Record<string, unknown>;
    expect(Object.keys(out)[0]).toBe("clone_unread");
    expect(out.clone_unread).toEqual({ cwd: dir, exit_code: 128, stderr_class: "not_a_repository" });
    expect("clone_behind" in out).toBe(false);
    expect(JSON.stringify(out)).not.toContain("fresh clone");
  });
});

describe("refreshInPlace(): a clone its rows record that git could not read", () => {
  const made = (dir: string) => async () => ({ cwd: dir, repo: "demo-vessel", branch: "dev", base: head(), super_base: "s", origin_url: g(copy, "config", "--get", "remote.origin.url").trim() });
  it("[MUST-FAIL] is refused as could not be read, not as behind, and moves nothing", async () => {
    g(copy, "remote", "add", "origin", join(T, "nowhere.git"));
    const dir = unreadable();
    let tried = 0;
    const io = { refreshed: async () => { tried++; return { ok: true as const }; }, clonePlace: async () => ({}), committedTree: async () => ({}), movedOnto: async () => false };
    const r = await refreshInPlace({ dir, repo: "demo-vessel" }, env, made(dir) as never, io as never);
    expect([tried, r]).toEqual([0, { error: `${dir} could not be read`, conflicts: [], unread: { exit_code: 128, stderr_class: "not_a_repository" } }]);
    expect(cloneOf({ cwd: dir }, env)).toEqual({ dir, repo: "demo-vessel" });
  });
  it("[MUST-FAIL] a clone behind its copy whose refresh could not read it is refused as could not be read, with no claim of what it holds", async () => {
    const dir = fresh();
    writeFileSync(join(copy, "d.ts"), `${n}\n`); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "a push the clone lacks");
    const unread = { exit_code: 137, stderr_class: "timeout" as const };
    const io = { refreshed: async () => ({ ok: false as const, conflicts: [] as [], why: "the clone could not be read", unread }),
      clonePlace: async () => ({}), committedTree: async () => ({}), movedOnto: async () => false };
    const r = await refreshInPlace({ dir, repo: "demo-vessel" }, env, made(dir) as never, io as never);
    expect(r).toEqual({ error: `${dir} could not be read`, conflicts: [], unread });
  });
  it("[MUST-FAIL] the tool does not run in it, and its answer carries the exit and class", async () => {
    const unread = { exit_code: 128, stderr_class: "lock" as const };
    let ran = 0;
    const out = await freshFirst({ dir: "/x", repo: "demo-vessel" }, async () => { ran++; return {}; }, env,
      async () => ({ error: "/x could not be read", conflicts: [], unread }));
    expect([ran, out]).toEqual([0, { error: "/x could not be read", conflicts: [], unread }]);
  });
});
