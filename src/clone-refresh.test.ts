// SPDX-License-Identifier: MIT
// A walk clone behind this node's copy is brought onto it in place before a tool works there (clone-refresh.ts), and the
// clone's base follows from the tool's own answer (walk-rows.ts madeClone). Throwaway repositories; records is a stub.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshFirst, madeCurrent, refreshInPlace } from "./clone-refresh";
import { makeWorktree, refreshed } from "./git-worktree";
import { madeClone, type Made } from "./walk-rows";

setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "clone-refresh-test-"));
chmodSync(T, 0o755);
const ENV_KEYS = ["DISCOVERY_ENDPOINT", "SUPER_REPO_DIR", "MITOSIS_PUSH_CLONE_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t"); g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };
const SUPER = join(T, "super");
const ORIGIN = join(T, "demo.git");
const COPY = join(T, "clones", "demo");
const SEED = join(T, "seed");
const realFetch = globalThis.fetch;

beforeAll(() => {
  Object.assign(process.env, { DISCOVERY_ENDPOINT: "http://discovery.test", SUPER_REPO_DIR: SUPER, MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), WALK_TREES_DIR: join(T, "trees") });
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(SUPER, { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev"); writeFileSync(join(SUPER, "x"), "x\n"); commitAll(SUPER, "super base");
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  g(T, "clone", "-q", ORIGIN, SEED);
  writeFileSync(join(SEED, "a.txt"), "1\n2\n3\n4\n5\n"); writeFileSync(join(SEED, "b.txt"), "b\n");
  commitAll(SEED, "base"); g(SEED, "push", "-q", "origin", "HEAD:dev");
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, COPY);
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(T, { recursive: true, force: true });
});

/** Origin moves (a push lands), and the node's copy follows it. */
const moveOrigin = (file: string, text: string) => {
  g(SEED, "pull", "-q", "origin", "dev"); writeFileSync(join(SEED, file), text); commitAll(SEED, `move ${file}`); g(SEED, "push", "-q", "origin", "HEAD:dev");
  g(COPY, "pull", "-q", "origin", "dev");
  return g(COPY, "rev-parse", "HEAD");
};
/** A clone made at the copy's HEAD now, and the walk row that recorded it. */
const clone = async (): Promise<{ cwd: string; made: Made }> => {
  const w = await makeWorktree("demo");
  if ("error" in w) throw new Error(w.error);
  asOwner(w.cwd);
  return { cwd: w.cwd, made: { cwd: w.cwd, repo: "demo", branch: w.branch, base: w.base, super_base: w.super_base, origin_url: w.origin_url } };
};
const at = (made: Made) => async () => made;
const state = (cwd: string) => ({ head: g(cwd, "rev-parse", "HEAD"), status: g(cwd, "status", "--porcelain", "--untracked-files=all"), a: readFileSync(join(cwd, "a.txt"), "utf8") });

describe("a clone behind the copy is brought onto it in place", () => {
  it("[MUST-FAIL] (a) behind, no commits of its own, clean: HEAD is the copy's, and the answer says the new base", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b2\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ refreshed: { shape: "gitWorktree", cwd: c.cwd, repo: "demo", base: to, refreshed_from: c.made.base } });
    expect(g(c.cwd, "rev-parse", "HEAD")).toBe(to);
    // (e) asked again: not behind any more, nothing changes
    expect(await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at({ ...c.made, base: to }))).toBeNull();
  });

  it("[MUST-FAIL] (b) its own commit is replayed onto the copy's HEAD, and the diff from the copy is only that commit", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3x\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd);
    const oldTree = g(c.cwd, "rev-parse", "HEAD^{tree}");
    const to = moveOrigin("b.txt", "b3\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ refreshed: { base: to, carried: "commits" } });
    // where the clone is now, as fields (the walk reads its newest tree from them, never from words)
    expect(r).toMatchObject({ refreshed: { head: g(c.cwd, "rev-parse", "HEAD"), tree: g(c.cwd, "rev-parse", "HEAD^{tree}") } });
    // (f) the refreshed clone is a new tree: git_land takes a verdict only on its own tree, so one on the old tree lands nothing
    expect(g(c.cwd, "rev-parse", "HEAD^{tree}")).not.toBe(oldTree);
    expect(g(c.cwd, "log", "--format=%s", `${to}..HEAD`)).toBe("own change");
    expect(g(c.cwd, "diff", "--name-only", to, "HEAD")).toBe("a.txt");
  });

  it("[MUST-FAIL] (b2) uncommitted edits are carried across the move", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3\n4\n5y\n"); asOwner(c.cwd);
    const to = moveOrigin("b.txt", "b4\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ refreshed: { base: to, carried: "uncommitted" } });
    expect(readFileSync(join(c.cwd, "a.txt"), "utf8")).toBe("1\n2\n3\n4\n5y\n");
  });

  it("[MUST-FAIL] (c) a commit the copy's move conflicts with: the clone is left exactly as it was, and the paths are named", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\nmine\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd);
    const before = state(c.cwd);
    moveOrigin("a.txt", "1\n2\ntheirs\n4\n5\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ error: expect.stringContaining("could not be brought onto it"), conflicts: ["a.txt"] });
    expect(state(c.cwd)).toEqual(before);
  });

  it("(d) not behind: nothing is fetched or moved, and no answer", async () => {
    const c = await clone();
    const before = state(c.cwd);
    expect(await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made))).toBeNull();
    expect(state(c.cwd)).toEqual(before);
  });
});

describe("the tool runs only in a clone that is current", () => {
  const C = { dir: "/c", repo: "demo" }
  const R = { shape: "gitWorktree" as const, cwd: "/c", repo: "demo", branch: "dev", base: "B1", super_base: "s", origin_url: "o", refreshed_from: "B0" }
  it("[MUST-FAIL] (c) a clone that could not be carried: the tool does not run, and the answer names the paths", async () => {
    let ran = 0
    const out = await freshFirst(C, async () => { ran++; return { shape: "gitDiff" } }, process.env, async () => ({ error: "could not be brought onto it", conflicts: ["a.txt"] }))
    expect(ran).toBe(0)
    expect(out).toEqual({ error: "could not be brought onto it", conflicts: ["a.txt"] })
  })
  it("[MUST-FAIL] a refreshed clone: the tool runs, and its answer says so first", async () => {
    const out = await freshFirst(C, async () => ({ shape: "gitDiff", ff: true }), process.env, async () => ({ refreshed: R })) as Record<string, unknown>
    expect(Object.keys(out)[0]).toBe("refreshed")
    expect(out).toMatchObject({ refreshed: R, shape: "gitDiff", ff: true })
  })
  it("(d) not behind, or no clone: the tool's answer as it was", async () => {
    expect(await freshFirst(C, async () => ({ shape: "gitDiff" }), process.env, async () => null)).toEqual({ shape: "gitDiff" })
    expect(await freshFirst(null, async () => ({ shape: "x" }), process.env, async () => { throw new Error("not called") })).toEqual({ shape: "x" })
  })
})

describe("the clone's base follows the walk's own gitWorktree rows", () => {
  // records stubbed: rows answer by shape and top-level where, as records does
  let rows: Array<Record<string, unknown>> = [];
  const stub = () => {
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const p = JSON.parse(String(init?.body)).pointer;
      const where = (p.where ?? {}) as Record<string, unknown>;
      const out = rows.filter((r) => r.shape === p.shape && Object.entries(where).every(([k, v]) => r[k] === v));
      return new Response(JSON.stringify(out), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  };
  const W = { repo: "demo", branch: "dev", super_base: "s0", origin_url: "o" };
  const made = (seq: number, cwd: string, base: string, from?: string) => [
    { id: `ws${seq}`, seq, shape: "hop", role: "walk", phase: "started", call_id: `cw${seq}`, pointer_type: "git_worktree" },
    { id: `we${seq}`, seq: seq + 1, shape: "hop", role: "walk", phase: "ended", kind: "call", call_id: `cw${seq}`, output: { shape: "gitWorktree", cwd, base, ...W, ...(from ? { refreshed_from: from } : {}) } },
  ];
  // the row the walk writes from a tool's refreshed answer (walk 849af728), however long the answer was
  const refreshedRow = (seq: number, cwd: string, base: string, from: string, role = "walk") =>
    ({ id: `rw${seq}`, seq, shape: "gitWorktree", role, cwd, base, refreshed_from: from, ...W, call_id: `ct${seq}` });

  it("[MUST-FAIL] a refreshed row moves the clone's base, though the tool's answer on its hop was cut (no `refreshed` there)", async () => {
    stub();
    const cutHop = { id: "te5", seq: 5, shape: "hop", role: "walk", phase: "ended", kind: "call", call_id: "ct6", output: { cut: true, bytes: 70000 } };
    rows = [...made(1, "/c1", "B0"), cutHop, refreshedRow(6, "/c1", "B1", "B0")];
    expect(await madeClone("/c1")).toMatchObject({ base: "B1" });
  });

  it("[MUST-FAIL] a row for another clone, or not the walk's, does not move this clone's base", async () => {
    stub();
    rows = [...made(1, "/c3", "B0"), refreshedRow(5, "/c-other", "FORGED", "B0"), refreshedRow(6, "/c3", "FORGED", "B0", "described")];
    expect(await madeClone("/c3")).toMatchObject({ base: "B0" });
  });

  it("[MUST-FAIL] (h) the newest says the base, whichever wrote it: a git_worktree answer after a refresh row, and the other order", async () => {
    stub();
    rows = [...made(1, "/c2", "B0"), refreshedRow(5, "/c2", "B1", "B0"), ...made(7, "/c2", "B2", "B1")];
    expect(await madeClone("/c2")).toMatchObject({ base: "B2" });
    rows = [...made(1, "/c2", "B0"), ...made(3, "/c2", "B1", "B0"), refreshedRow(9, "/c2", "B2", "B1")];
    expect(await madeClone("/c2")).toMatchObject({ base: "B2" });
  });
});

describe("a clone moved onto a newer base that no row records is a fact, read from git and rows", () => {
  it("[MUST-FAIL] the clone moved but its rows still say the old base: the fact, with the new base; asked again from scratch, the same", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b9\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ refreshed: { base: to } });
    // no row recorded the move: the rows still say c.made.base
    const first = await madeCurrent(c.cwd, at(c.made));
    expect(first).toMatchObject({ moved_unrecorded: to, error: expect.stringContaining("no row records") });
    // nothing is kept in memory: a later call (as after a restart) reads the same from git and rows
    expect(await madeCurrent(c.cwd, at(c.made))).toEqual(first);
  });

  it("[MUST-FAIL] the call that refreshes the clone works on the new base: its own check does not refuse its own move", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b11\n");
    // the real wrapper and refresh; the rows (made) still say the old base, as they do until the walk records this answer
    const out = await freshFirst({ dir: c.cwd, repo: "demo" }, async () => madeCurrent(c.cwd, at({ ...c.made, super_base: "an-older-super-base" })), process.env,
      (cl, env) => refreshInPlace(cl, env, at(c.made))) as Record<string, unknown>;
    expect(out).toMatchObject({ refreshed: { base: to }, base: to });
    // the super base the refresh read now (the hooks a commit is judged by), not the one the clone was made at
    expect(out.super_base).toBe((out.refreshed as { super_base: string }).super_base);
    expect("moved_unrecorded" in out).toBe(false);
    // the next call, outside that one (as after the walk failed to record it, or a restart): the fact
    expect(await madeCurrent(c.cwd, at(c.made))).toMatchObject({ moved_unrecorded: to, error: expect.stringContaining("git_worktree for demo") });
  });

  it("[MUST-FAIL] the stuck fact's exit: git_worktree's refresh from the recorded base onto the copy succeeds on a clone already moved, keeping its change", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3z\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd);
    const to = moveOrigin("b.txt", "b12\n");
    await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    const tree = g(c.cwd, "rev-parse", "HEAD^{tree}");
    // the walk recorded nothing; git_worktree for the request then refreshes from the base its rows say (what chooseOrClone does)
    const r = await refreshed(c.cwd, c.made.base, to, "dev", COPY);
    expect(r).toMatchObject({ ok: true });
    expect(g(c.cwd, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(g(c.cwd, "log", "--format=%s", `${to}..HEAD`)).toBe("own change");
  });

  it("[MUST-FAIL] control: a clone whose move a row records gives no fact; a clone at its recorded base gives none", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b10\n");
    await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(await madeCurrent(c.cwd, at({ ...c.made, base: to }))).toMatchObject({ base: to });
    const d = await clone();
    expect(await madeCurrent(d.cwd, at(d.made))).toMatchObject({ base: d.made.base });
  });
});
