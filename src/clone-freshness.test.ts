// A walk clone is said to be behind when this node's copy of its repository has moved past it. Throwaway repositories.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { behind, cloneOf } from "./clone-freshness";

const T = mkdtempSync(join(tmpdir(), "clone-fresh-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: gitEnv, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const env = { MITOSIS_PUSH_CLONE_DIR: join(T, "vessels"), WALK_TREES_DIR: join(T, "trees") };
const copy = join(T, "vessels", "demo-vessel");
const clone = join(T, "trees", "demo-vessel-mwabc123-1a2b3c4d");
mkdirSync(copy, { recursive: true }); mkdirSync(join(T, "trees"));
g(copy, "init", "-q", "-b", "dev"); writeFileSync(join(copy, "a.ts"), "1\n"); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "base");
g(T, "clone", "-q", copy, clone);
if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", clone]);

describe("clone freshness", () => {
  it("[MUST-FAIL] a path in a walk clone names that clone and its repository; any other path names none", () => {
    expect(cloneOf({ path: join(clone, "src", "a.ts") }, env)).toEqual({ dir: clone, repo: "demo-vessel" });
    expect(cloneOf({ cwd: clone, cmd: "ls" }, env)).toEqual({ dir: clone, repo: "demo-vessel" });
    expect(cloneOf({ path: join(T, "elsewhere", "a.ts") }, env)).toBeNull();
    expect(cloneOf({ path: "src/a.ts" }, env)).toBeNull();
  });

  it("[MUST-FAIL] a path names the clone it resolves into: `..` out of a clone names none, and one into another clone names that one", () => {
    const other = join(T, "trees", "demo-vessel-mwabc123-9f9f9f9f");
    expect(cloneOf({ path: `${clone}/../../outside.txt` }, env)).toBeNull();
    expect(cloneOf({ path: `${clone}/src/../../${other.split("/").pop()}/a.ts` }, env)).toEqual({ dir: other, repo: "demo-vessel" });
    expect(cloneOf({ path: `${clone}/src/../a.ts` }, env)).toEqual({ dir: clone, repo: "demo-vessel" });
  });

  // A symlink inside a clone (git tracks them, so a repository can carry one) leads a write elsewhere: the clone named is
  // the one the write lands in, as the tool roots resolve it, never the one the path is spelled through.
  const linked = join(T, "trees", "demo-vessel-mwabc123-5e5e5e5e");
  const target = join(T, "trees", "demo-vessel-mwabc123-7a7a7a7a");
  const away = join(T, "away");
  mkdirSync(linked); mkdirSync(target); mkdirSync(away);
  symlinkSync(target, join(linked, "to-other")); symlinkSync(away, join(linked, "to-away"));
  it("[MUST-FAIL] a path through a symlink in a clone names the clone it lands in: another clone names that one, outside every clone none", () => {
    expect(cloneOf({ path: join(linked, "to-other", "a.ts") }, env)).toEqual({ dir: target, repo: "demo-vessel" });
    expect(cloneOf({ path: join(linked, "to-away", "a.ts") }, env)).toBeNull();
    expect(cloneOf({ cwd: join(linked, "to-away") }, env)).toBeNull();
    expect(cloneOf({ path: join(linked, "a-new-file.ts") }, env)).toEqual({ dir: linked, repo: "demo-vessel" });
  });

  it("[MUST-FAIL] a trees directory configured through a symlink: a path spelled either way names the clone under the directory as configured", () => {
    const viaLink = join(T, "trees-link");
    symlinkSync(join(T, "trees"), viaLink);
    const linkedEnv = { ...env, WALK_TREES_DIR: viaLink };
    const name = clone.split("/").pop()!;
    expect(cloneOf({ path: join(viaLink, name, "a.ts") }, linkedEnv)).toEqual({ dir: join(viaLink, name), repo: "demo-vessel" });
    expect(cloneOf({ path: join(clone, "a.ts") }, linkedEnv)).toEqual({ dir: join(viaLink, name), repo: "demo-vessel" });
  });

  it("[MUST-FAIL] an edit through a symlink out of a clone, landing outside every clone, names no clone: no cwd, no note on that clone", async () => {
    Object.assign(process.env, env);
    const { resolvers } = await import("./index");
    writeFileSync(join(away, "e.txt"), "one\n");
    const out = (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path: join(linked, "to-away", "e.txt"), old_string: "one", new_string: "two" } } } } as never)) as Record<string, unknown>;
    expect(out).toMatchObject({ shape: "fileEditResult", ok: true });
    expect(readFileSync(join(away, "e.txt"), "utf8")).toBe("two\n");
    expect("cwd" in out).toBe(false);
    expect("clone_behind" in out).toBe(false);
  });

  it("[GUARD] the clone root itself names the clone; a sibling clone whose name extends this one's names itself; a sibling of the trees directory names none", () => {
    expect(cloneOf({ cwd: clone }, env)).toEqual({ dir: clone, repo: "demo-vessel" });
    expect(cloneOf({ path: `${clone}-other/a.ts` }, env)).toEqual({ dir: `${clone}-other`, repo: "demo-vessel-mwabc123" });
    expect(cloneOf({ path: join(T, "trees-demo-vessel-1", "a.ts") }, env)).toBeNull();
  });

  it("[MUST-FAIL] a clone at the copy's head is not behind; once the copy moves on, it is, and is told to take a fresh clone", async () => {
    const c = cloneOf({ path: join(clone, "a.ts") }, env)!;
    expect(await behind(c, env)).toBeNull();
    writeFileSync(join(copy, "b.ts"), "2\n"); g(copy, "add", "-A"); g(copy, "commit", "-q", "-m", "a push, installed");
    const why = await behind(c, env);
    expect(why).toContain("ask for git_worktree of demo-vessel for a fresh clone");
    expect(why).toContain(g(copy, "rev-parse", "HEAD").slice(0, 10));
  });

  it("[MUST-FAIL] every tool's answer about a path in a clone that is behind carries why, and only then", async () => {
    Object.assign(process.env, env);
    const { resolvers } = await import("./index");
    const read = resolvers.get("fs_read")!;
    const ctx = (path: string) => ({ body: { impulse: { pointer: { path } } } }) as never;
    const inside = (await read(ctx(join(clone, "a.ts")))) as Record<string, unknown>;
    expect(String(inside.clone_behind)).toContain("for a fresh clone");
    const outside = (await read(ctx(join(copy, "a.ts")))) as Record<string, unknown>;
    expect("clone_behind" in outside).toBe(false);
    expect(resolvers.get("git_worktree")).toBeDefined();
    // a long answer is cut by the walk to its start (a hop keeps 16 KiB, a refusal 1000 characters): the note leads it
    writeFileSync(join(clone, "big.ts"), `${"// filler line\n".repeat(2000)}`);
    const big = (await read(ctx(join(clone, "big.ts")))) as Record<string, unknown>;
    expect(Object.keys(big)[0]).toBe("clone_behind");
    expect(JSON.stringify(big).length).toBeGreaterThan(16 * 1024);
    expect(JSON.stringify(big).slice(0, 1000)).toContain("for a fresh clone");
  });

  it("[MUST-FAIL] an edit through `..` out of a clone, done outside every clone, names no clone: no cwd, no note on that clone", async () => {
    Object.assign(process.env, env);
    const { resolvers } = await import("./index");
    const outside = join(T, "outside-edit.txt");
    writeFileSync(outside, "one\n");
    const out = (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path: `${clone}/../../outside-edit.txt`, old_string: "one", new_string: "two" } } } } as never)) as Record<string, unknown>;
    expect(out).toMatchObject({ shape: "fileEditResult", ok: true });
    expect("cwd" in out).toBe(false);
    expect("clone_behind" in out).toBe(false);
  });

  it("[MUST-FAIL] only a call declared to run on held edits runs past a refusal for commits and edits held together", async () => {
    Object.assign(process.env, env);
    const { wrapped } = await import("./index");
    const refused = async () => ({ error: "commit or drop the edits first", conflicts: [], changed: true, held: "commits_and_edits" as const });
    const ctx = { body: { impulse: { pointer: { cwd: clone, message: "m" } } } } as never;
    let ran = 0;
    const h = async () => { ran++; return { shape: "gitCommitResult" } };
    const commit = (await wrapped("git_commit", h as never, refused)(ctx)) as Record<string, unknown>;
    expect([ran, commit.refresh_refused]).toEqual([1, "commits_and_edits"]);
    const edit = (await wrapped("fs_edit", h as never, refused)(ctx)) as Record<string, unknown>;
    expect([ran, edit.held]).toEqual([1, "commits_and_edits"]);
  });

  it("[GUARD] the wrapper's note on a clone behind its copy names the way on from the refusal it was given", async () => {
    Object.assign(process.env, env);
    const { wrapped } = await import("./index");
    const ctx = { body: { impulse: { pointer: { path: join(clone, "a.ts") } } } } as never;
    const h = async () => ({ shape: "fileContent" });
    const held = async () => ({ error: "commit or drop the edits first", conflicts: [], changed: true, held: "commits_and_edits" as const });
    const onHeld = (await wrapped("fs_read", h as never, held)(ctx)) as Record<string, unknown>;
    expect(String(onHeld.clone_behind)).toContain(`git_commit in ${clone} commits the edits`);
    const conflict = async () => ({ error: "could not be brought onto it", conflicts: ["a.ts"], changed: true });
    const onConflict = (await wrapped("fs_read", h as never, conflict)(ctx)) as Record<string, unknown>;
    expect(String(onConflict.clone_behind)).toContain(`also changed a.ts, which the change in ${clone} changes`);
  });
});
