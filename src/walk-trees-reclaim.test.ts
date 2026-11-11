// walk_trees_reclaim removes the clones nothing will use again, decided from the walk's rows (records is a stub here),
// and nothing it cannot read or does not own. Every clone is a real throwaway repository.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorktree } from "./git-worktree";
import { reclaimWalkTrees } from "./walk-trees-reclaim";

const T = mkdtempSync(join(tmpdir(), "walk-trees-reclaim-"));
chmodSync(T, 0o755);
const SRC = join(T, "src");
const TREES = join(T, "trees");
const env = { WALK_TREES_DIR: TREES };
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const realFetch = globalThis.fetch;
const savedDiscovery = process.env.DISCOVERY_ENDPOINT;

// A clone as git_worktree makes one: from the copy, on its own walk/<name> branch.
const clone = (name: string): string => {
  const cwd = join(TREES, name);
  g(T, "clone", "-q", SRC, cwd);
  g(cwd, "checkout", "-q", "-b", `walk/${name}`);
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
  return cwd;
};

// records, as the stub answers it: rows by shape, and the open roots of the walk's episode.
let rows: Record<string, unknown[]> = {};
let openRoots: string[] = [];
let failing = false;
const answer = () => {
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    if (failing) return new Response("down", { status: 503 });
    const p = JSON.parse(String(init?.body)).pointer;
    if (p.episode !== undefined) return Response.json({ shared: [], roots: openRoots.map((id) => ({ root: { id }, rows: [] })) });
    return Response.json(rows[p.shape] ?? []);
  }) as typeof fetch;
};
let n = 0;
const made = (cwd: string, root: string) => {
  const sel = `sel-${++n}`;
  return [
    { id: sel, shape: "selection", role: "walk", root },
    { id: `h-${n}`, shape: "hop", role: "walk", phase: "ended", pointer_type: "git_worktree", call_id: `c-${n}`, selection_ref: sel, output: { cwd } },
  ];
};
const world = (parts: Array<Record<string, unknown>>, open: string[]) => {
  rows = { arm: [{ id: "arm-1", shape: "arm", vessel_id: "walk-1" }] };
  for (const r of parts) (rows[String(r.shape)] ??= []).push(r);
  openRoots = open;
};

beforeAll(() => {
  process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
  mkdirSync(SRC);
  g(SRC, "init", "-q", "-b", "dev");
  writeFileSync(join(SRC, "a.txt"), "one\n");
  g(SRC, "add", "-A");
  g(SRC, "commit", "-q", "-m", "base");
});
beforeEach(() => {
  rmSync(TREES, { recursive: true, force: true });
  mkdirSync(TREES);
  chmodSync(TREES, 0o755);
  failing = false;
  answer();
});
afterAll(() => {
  globalThis.fetch = realFetch;
  if (savedDiscovery === undefined) delete process.env.DISCOVERY_ENDPOINT; else process.env.DISCOVERY_ENDPOINT = savedDiscovery;
  rmSync(T, { recursive: true, force: true });
});

describe("walk_trees_reclaim", () => {
  it("[MUST-FAIL] removes the unchanged clones of a closed request, and keeps one of an open request", async () => {
    const [c1, c2, c3, c4] = ["super-a1", "super-a2", "super-a3", "super-a4"].map(clone);
    world([...made(c1, "R1"), ...made(c2, "R1"), ...made(c3, "R1"), ...made(c4, "R2")], ["R2"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(r.removed.sort()).toEqual([c1, c2, c3].sort());
    expect([c1, c2, c3].map(existsSync)).toEqual([false, false, false]);
    expect(existsSync(c4)).toBe(true);
  });

  it("[MUST-FAIL] removes nothing when records cannot be read, or lists no open request while there are selections", async () => {
    const [c1, c2] = ["super-b1", "super-b2"].map(clone);
    world([...made(c1, "R1"), ...made(c2, "R1")], []);
    failing = true;
    expect("error" in (await reclaimWalkTrees(env))).toBe(true);
    failing = false;
    expect("error" in (await reclaimWalkTrees(env))).toBe(true); // no open root, yet selections exist
    expect([c1, c2].map(existsSync)).toEqual([true, true]);
  });

  it("[MUST-FAIL] keeps and reports a changed clone of a closed request that did not land; removes one that landed", async () => {
    const [changed, landedCwd, open] = ["super-c1", "super-c2", "super-c3"].map(clone);
    writeFileSync(join(changed, "a.txt"), "two\n");
    writeFileSync(join(landedCwd, "a.txt"), "three\n");
    world([...made(changed, "R1"), ...made(landedCwd, "R1"), ...made(open, "R2"),
      { id: "h-land", shape: "hop", role: "walk", phase: "ended", pointer_type: "git_land", call_id: "c-land", selection_ref: "sel-x", output: { cwd: landedCwd } }], ["R2"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(existsSync(changed)).toBe(true);
    expect(r.reported.map((x) => x.cwd)).toContain(changed);
    expect(existsSync(landedCwd)).toBe(false);
  });

  it("[MUST-FAIL] keeps the newest unchanged clone of each origin: git_worktree hands it out again", async () => {
    const [older, newest] = ["super-d1", "super-d2"].map(clone);
    world([...made(older, "R1"), ...made(newest, "R1")], ["R9"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(r.removed).toEqual([older]);
    expect(existsSync(newest)).toBe(true);
  });

  it("[MUST-FAIL] keeps the clones of a request with a call started and not yet ended", async () => {
    const [c1, c2] = ["super-e1", "super-e2"].map(clone);
    world([...made(c1, "R1"), ...made(c2, "R1"),
      { id: "sel-busy", shape: "selection", role: "walk", root: "R1" },
      { id: "h-busy", shape: "hop", role: "walk", phase: "started", pointer_type: "fs_edit", call_id: "c-busy", selection_ref: "sel-busy" }], ["R9"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(r.removed).toEqual([]);
    expect([c1, c2].map(existsSync)).toEqual([true, true]);
  });

  it("[MUST-FAIL] an unchanged clone no row names goes, except while a git_worktree call is being made", async () => {
    const [stray, target] = ["super-f1", "super-f2"].map(clone);
    world([], ["R9"]);
    rows.selection = [{ id: "sel-mk", shape: "selection", role: "walk", root: "R9" }];
    rows.hop = [{ id: "h-mk", shape: "hop", role: "walk", phase: "started", pointer_type: "git_worktree", call_id: "c-mk", selection_ref: "sel-mk" }];
    expect((await reclaimWalkTrees(env) as { removed: string[] }).removed).toEqual([]);
    rows.hop.push({ id: "h-mk2", shape: "hop", role: "walk", phase: "ended", pointer_type: "git_worktree", call_id: "c-mk", selection_ref: "sel-mk", output: { cwd: target } });
    expect((await reclaimWalkTrees(env) as { removed: string[] }).removed).toEqual([stray]);
  });

  it("[MUST-FAIL] a call started under a selection records does not list keeps every clone a row names", async () => {
    const [c1, c2] = ["super-h1", "super-h2"].map(clone);
    world([...made(c1, "R1"), ...made(c2, "R1"),
      { id: "h-orphan", shape: "hop", role: "walk", phase: "started", pointer_type: "fs_edit", call_id: "c-orphan", selection_ref: "sel-unlisted" }], ["R9"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(r.removed).toEqual([]);
    expect([c1, c2].map(existsSync)).toEqual([true, true]);
  });

  it("[MUST-FAIL] git_worktree waits while a reclaim is deciding and removing, so it is never handed a clone being removed", async () => {
    // a copy for git_worktree to clone from, and the clones directory both share
    const copies = join(T, "copies");
    if (!existsSync(join(copies, "demo"))) { mkdirSync(copies, { recursive: true }); g(T, "clone", "-q", SRC, join(copies, "demo")); }
    Object.assign(process.env, { SUPER_REPO_DIR: SRC, MITOSIS_PUSH_CLONE_DIR: copies, WALK_TREES_DIR: TREES });
    const [old, kept] = ["demo-a1", "demo-a2"].map(clone); // the newer one is the reuse target, the older goes
    world([...made(old, "R1"), ...made(kept, "R1")], ["R9"]);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let removing = false;
    const reclaim = reclaimWalkTrees(env, async (p) => { removing = true; await gate; rmSync(p, { recursive: true }); });
    for (let i = 0; i < 200 && !removing; i++) await Bun.sleep(10);
    expect(removing).toBe(true);
    let settled = false;
    const handed = makeWorktree("demo").then((w) => { settled = true; return w; });
    await Bun.sleep(300);
    expect(settled).toBe(false); // held until the reclaim is done
    release();
    const [r, w] = await Promise.all([reclaim, handed]);
    if ("error" in r || "error" in w) throw new Error(JSON.stringify([r, w]));
    expect(r.removed).not.toContain(w.cwd);
    expect(existsSync(w.cwd)).toBe(true);
  });

  it("never touches what is not a whole clone directly under the clones directory (a guard)", async () => {
    const outside = join(T, "outside-clone");
    if (!existsSync(outside)) { g(T, "clone", "-q", SRC, outside); g(outside, "checkout", "-q", "-b", "walk/outside-clone"); }
    symlinkSync(outside, join(TREES, "super-g0-link"));
    mkdirSync(join(TREES, "super-g1-plain"));
    mkdirSync(join(TREES, "super-g2-gitfile"));
    writeFileSync(join(TREES, "super-g2-gitfile", ".git"), `gitdir: ${join(outside, ".git")}\n`);
    world([], ["R9"]);
    const r = await reclaimWalkTrees(env);
    if ("error" in r) throw new Error(r.error);
    expect(r.removed).toEqual([]);
    expect([join(TREES, "super-g0-link"), join(TREES, "super-g1-plain"), join(TREES, "super-g2-gitfile"), outside].map(existsSync)).toEqual([true, true, true, true]);
  });
});
