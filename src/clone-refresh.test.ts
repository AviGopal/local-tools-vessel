// SPDX-License-Identifier: MIT
// A walk clone behind this node's copy is brought onto it in place before a tool works there (clone-refresh.ts), and the
// clone's base follows from the tool's own answer (walk-rows.ts madeClone). Throwaway repositories; records is a stub.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshFirst, madeCurrent, movedOnto, refreshInPlace } from "./clone-refresh";
import { clonePlace, committedTree, makeWorktree, refreshed } from "./git-worktree";
import { madeClone, type Made } from "./walk-rows";
import { behind, refusalOf } from "./clone-freshness";
import { runsOnHeldEdits } from "./shape-inputs";

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
    expect(r).toMatchObject({ clone: { shape: "gitWorktree", cwd: c.cwd, repo: "demo", base: to, refreshed_from: c.made.base } });
    expect(g(c.cwd, "rev-parse", "HEAD")).toBe(to);
    // (e) asked again: not behind any more, nothing changes
    expect(await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at({ ...c.made, base: to }))).toBeNull();
  });

  it("[MUST-FAIL] a refresh carrying commits says its committed tree; one carrying an uncommitted edit says none, and says tree as before", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3c\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd);
    const to = moveOrigin("b.txt", "b-ct1\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ clone: { base: to, carried: "commits", tree: g(c.cwd, "rev-parse", "HEAD^{tree}"), committed_tree: g(c.cwd, "rev-parse", "HEAD^{tree}") } });
    const u = await clone();
    writeFileSync(join(u.cwd, "a.txt"), "1\n2u\n3\n4\n5\n"); asOwner(u.cwd);
    moveOrigin("b.txt", "b-ct2\n");
    const ru = await refreshInPlace({ dir: u.cwd, repo: "demo" }, process.env, at(u.made)) as { clone: Record<string, unknown> };
    expect([ru.clone.carried, ru.clone.tree, "committed_tree" in ru.clone]).toEqual(["uncommitted", g(u.cwd, "rev-parse", "HEAD^{tree}"), false]);
  });

  it("[MUST-FAIL] (b) its own commit is replayed onto the copy's HEAD, and the diff from the copy is only that commit", async () => {
    const c = await clone();
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3x\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd);
    const oldTree = g(c.cwd, "rev-parse", "HEAD^{tree}");
    const to = moveOrigin("b.txt", "b3\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made));
    expect(r).toMatchObject({ clone: { base: to, carried: "commits" } });
    // where the clone is now, as fields (the walk reads its newest tree from them, never from words)
    expect(r).toMatchObject({ clone: { head: g(c.cwd, "rev-parse", "HEAD"), tree: g(c.cwd, "rev-parse", "HEAD^{tree}") } });
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
    expect(r).toMatchObject({ clone: { base: to, carried: "uncommitted" } });
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
    const out = await freshFirst(C, async () => ({ shape: "gitDiff", ff: true }), process.env, async () => ({ clone: R })) as Record<string, unknown>
    expect(Object.keys(out)[0]).toBe("clone")
    expect(out).toMatchObject({ clone: R, shape: "gitDiff", ff: true })
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
    expect(r).toMatchObject({ clone: { base: to } });
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
    expect(out).toMatchObject({ clone: { base: to }, base: to });
    // the super base the refresh read now (the hooks a commit is judged by), not the one the clone was made at
    expect(out.super_base).toBe((out.clone as { super_base: string }).super_base);
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

describe("a clone moved before its refresh failed is said moved, so the walk records it", () => {
  const io = { refreshed, clonePlace, committedTree, movedOnto };
  const lost = new Error("spawn failed");
  const tool = () => { let ran = 0; return { ran: () => ran, run: async () => { ran++; return { shape: "gitDiff" } } } };
  it("[MUST-FAIL] a throw after the move: the answer says the clone's new base, first, beside the error, and the tool does not run", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b-sm1\n");
    const t = tool();
    const out = await freshFirst({ dir: c.cwd, repo: "demo" }, t.run, process.env, (cl, env) => refreshInPlace(cl, env, at(c.made),
      { ...io, refreshed: async (...a: Parameters<typeof refreshed>) => { await refreshed(...a); throw lost } })) as Record<string, unknown>;
    expect(g(c.cwd, "rev-parse", "HEAD")).toBe(to);
    expect(Object.keys(out)[0]).toBe("clone");
    expect(out).toMatchObject({ clone: { shape: "gitWorktree", cwd: c.cwd, base: to, refreshed_from: c.made.base, head: to, tree: g(c.cwd, "rev-parse", "HEAD^{tree}") },
      error: expect.stringContaining("spawn failed"), conflicts: [] });
    expect(t.ran()).toBe(0);
  });
  it("[MUST-FAIL] a refusal after the move: the answer says the new base beside the refusal", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b-sm2\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made),
      { ...io, refreshed: async (...a: Parameters<typeof refreshed>) => { await refreshed(...a); return { ok: false, changed: false, conflicts: [], why: "the move did not end on the new base" } } });
    const tree = g(c.cwd, "rev-parse", "HEAD^{tree}");
    expect(r).toMatchObject({ clone: { base: to, refreshed_from: c.made.base, head: to, tree, committed_tree: tree }, error: expect.stringContaining("did not end on the new base") });
  });
  it("[MUST-FAIL] a moved clone whose place cannot be read is still said moved, without the fields that could not be read", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b-sm3\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made), { ...io, clonePlace: async () => { throw lost } }) as { clone: Record<string, unknown> };
    expect(r.clone).toMatchObject({ base: to, refreshed_from: c.made.base, committed_tree: g(c.cwd, "rev-parse", "HEAD^{tree}") });
    expect(["head" in r.clone, "tree" in r.clone, "error" in r]).toEqual([false, false, false]);
  });
  it("[GUARD] a moved clone whose committed tree cannot be read is still said moved, without committed_tree", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b-sm8\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made), { ...io, committedTree: async () => { throw lost } }) as { clone: Record<string, unknown> };
    expect(r.clone).toMatchObject({ base: to, refreshed_from: c.made.base, head: to, tree: g(c.cwd, "rev-parse", "HEAD^{tree}") });
    expect(["committed_tree" in r.clone, "error" in r]).toEqual([false, false]);
  });
  it("a throw before the move: no clone is said, and the tool runs as before", async () => {
    const c = await clone();
    moveOrigin("b.txt", "b-sm4\n");
    const before = state(c.cwd);
    const t = tool();
    const out = await freshFirst({ dir: c.cwd, repo: "demo" }, t.run, process.env, (cl, env) => refreshInPlace(cl, env, at(c.made),
      { ...io, refreshed: async () => { throw lost } }));
    expect([out, t.ran()]).toEqual([{ shape: "gitDiff" }, 1]);
    expect(state(c.cwd)).toEqual(before);
  });
  it("a refusal that left the clone as it was: no clone is said", async () => {
    const c = await clone();
    moveOrigin("b.txt", "b-sm5\n");
    const r = await refreshInPlace({ dir: c.cwd, repo: "demo" }, process.env, at(c.made),
      { ...io, refreshed: async () => ({ ok: false, changed: false, conflicts: [], why: "could not be read" }) }) as Record<string, unknown>;
    expect(["clone" in r, r.error]).toEqual([false, expect.stringContaining("could not be read")]);
  });
  it("a throw mid-replay (HEAD detached on the new base): not said as moved", async () => {
    const c = await clone();
    const to = moveOrigin("b.txt", "b-sm6\n");
    const t = tool();
    const out = await freshFirst({ dir: c.cwd, repo: "demo" }, t.run, process.env, (cl, env) => refreshInPlace(cl, env, at(c.made),
      { ...io, refreshed: async () => { g(c.cwd, "fetch", "-q", COPY, "dev"); g(c.cwd, "checkout", "-q", "--detach", to); throw lost } }));
    expect(out).toEqual({ shape: "gitDiff" });
  });
  it("a clone whose move cannot be read: not said as moved", async () => {
    const c = await clone();
    moveOrigin("b.txt", "b-sm7\n");
    const t = tool();
    const out = await freshFirst({ dir: c.cwd, repo: "demo" }, t.run, process.env, (cl, env) => refreshInPlace(cl, env, at(c.made),
      { ...io, refreshed: async (...a: Parameters<typeof refreshed>) => { await refreshed(...a); throw lost }, movedOnto: async () => { throw lost } }));
    expect(out).toEqual({ shape: "gitDiff" });
  });
});

describe("a clone holding commits and edits together: git_commit runs in it as it is, and the note names the way on", () => {
  const D = (cwd: string) => ({ dir: cwd, repo: "demo" })
  const noteAfter = (cwd: string, out: unknown) => behind(D(cwd), process.env, refusalOf(out))
  /** A clone with a commit of its own and an uncommitted edit on top, behind a copy that moved a path it does not change. */
  const held = async (tag: string) => {
    const c = await clone()
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3h\n4\n5\n"); commitAll(c.cwd, "own change")
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\n3h\n4\n5h\n"); asOwner(c.cwd)
    return { c, to: moveOrigin("b.txt", `b-${tag}\n`) }
  }
  const refreshOf = (made: Made) => (cl: { dir: string; repo: string }, env: NodeJS.ProcessEnv) => refreshInPlace(cl, env, at(made))

  it("[MUST-FAIL] git_commit runs there, and the next call carries the commits onto the copy", async () => {
    const { c, to } = await held("h1")
    let ran = 0
    const out = await freshFirst(D(c.cwd), async () => { ran++; commitAll(c.cwd, "the edits"); asOwner(c.cwd); return { shape: "gitCommitResult" } },
      process.env, refreshOf(c.made), runsOnHeldEdits("git_commit"))
    expect(ran).toBe(1)
    expect(out).toMatchObject({ refresh_refused: "commits_and_edits", shape: "gitCommitResult" })
    expect(await noteAfter(c.cwd, out)).toContain(`its edits are committed, so the next tool called in ${c.cwd} carries the commits onto the copy`)
    expect(await refreshInPlace(D(c.cwd), process.env, at(c.made))).toMatchObject({ clone: { base: to, carried: "commits" } })
  })

  it("[MUST-FAIL] any other call does not run there, and is told to commit the edits there first", async () => {
    const { c } = await held("h2")
    let ran = 0
    const out = await freshFirst(D(c.cwd), async () => { ran++; return { shape: "fileContent" } }, process.env, refreshOf(c.made), runsOnHeldEdits("fs_read"))
    expect(ran).toBe(0)
    expect(out).toMatchObject({ held: "commits_and_edits", changed: true })
    const why = await noteAfter(c.cwd, out)
    expect(why).toContain(`git_commit in ${c.cwd} commits the edits, then the next tool called there carries the commits onto the copy`)
    expect(why).not.toContain("fresh clone")
  })

  it("[MUST-FAIL] a git_commit refused there leaves the edits held, and the note still says commit them there", async () => {
    const { c } = await held("h3")
    const out = await freshFirst(D(c.cwd), async () => ({ error: "refused by the pre-commit hook" }), process.env, refreshOf(c.made), runsOnHeldEdits("git_commit"))
    expect(out).toMatchObject({ refresh_refused: "commits_and_edits", error: "refused by the pre-commit hook" })
    expect(await noteAfter(c.cwd, out)).toContain(`git_commit in ${c.cwd} commits the edits`)
  })

  it("[GUARD] a clean clone behind the copy is brought onto it before git_commit runs", async () => {
    const c = await clone()
    const to = moveOrigin("b.txt", "b-h4\n")
    let headAtRun = ""
    const out = await freshFirst(D(c.cwd), async () => { headAtRun = g(c.cwd, "rev-parse", "HEAD"); return { shape: "gitCommitResult" } },
      process.env, refreshOf(c.made), true) as Record<string, unknown>
    expect(headAtRun).toBe(to)
    expect(Object.keys(out)[0]).toBe("clone")
    expect("refresh_refused" in out).toBe(false)
  })

  it("[MUST-FAIL] a change the copy's move conflicts with: no call runs, git_commit included, and the note names the paths, the clone and a fresh clone", async () => {
    const c = await clone()
    writeFileSync(join(c.cwd, "a.txt"), "1\n2\nmine-h5\n4\n5\n"); commitAll(c.cwd, "own change"); asOwner(c.cwd)
    moveOrigin("a.txt", "1\n2\ntheirs-h5\n4\n5\n")
    let ran = 0
    const out = await freshFirst(D(c.cwd), async () => { ran++; return {} }, process.env, refreshOf(c.made), runsOnHeldEdits("git_commit"))
    expect(ran).toBe(0)
    expect(out).toMatchObject({ conflicts: ["a.txt"] })
    const why = await noteAfter(c.cwd, out)
    expect(why).toContain(`also changed a.txt, which the change in ${c.cwd} changes`)
    expect(why).toContain("ask for git_worktree of demo for a fresh clone and make the change to those paths again there")
  })

  it("[MUST-FAIL] a clone that held no change (clean, unreadable, or no refresh said) has nothing to make again; one that held a change does", async () => {
    const c = await clone()
    moveOrigin("b.txt", "b-h6\n")
    for (const r of [refusalOf({ error: "the clone could not be read", conflicts: [], changed: false }), null]) {
      const why = await behind(D(c.cwd), process.env, r)
      expect(why).toContain("ask for git_worktree of demo for a fresh clone")
      expect(why).not.toContain("make the edits again")
    }
    expect(await behind(D(c.cwd), process.env, refusalOf({ error: "the new base could not be fetched", conflicts: [], changed: true })))
      .toContain("for a fresh clone and make the edits again there")
  })
})
