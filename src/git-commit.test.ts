// git_worktree makes a clone for one change; git_commit commits in it only when the walk's row says git_worktree made
// it, checked by the super-repo's hooks as of that making, without this vessel's credentials and without a shell.
// Everything runs against throwaway repositories; records is a stub answering the walk's rows.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone } from "./git-commit";
import { makeWorktree } from "./git-worktree";
import { madeClone, type Made } from "./walk-rows";
import { callsRead, episodeRead, recordRead, walkCall } from "./walk-call-rows.test-helper";

// Run as root, git in the code under test drops to the shell user (shell-privilege.ts), which must read these
// fixtures: the test root is opened up, and what hooks write goes to a directory anyone may write.
const T = mkdtempSync(join(tmpdir(), "git-commit-test-"));
chmodSync(T, 0o755);
const OUT = join(T, "out");
mkdirSync(OUT);
chmodSync(OUT, 0o777);
const PAT = "pat-value-that-must-not-reach-a-hook";
const ENV_KEYS = ["DISCOVERY_ENDPOINT", "GITHUB_PUSH_TOKEN", "SUPER_REPO_DIR", "MITOSIS_PUSH_CLONE_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const realFetch = globalThis.fetch;
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
// A node gives commits their author from its system git config; a test clone gets one of its own. And what this test
// writes into a clone as itself is handed back to the clone's owner, the shell user when the test runs as root.
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t"); g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };

// Each hook records which one ran and the env it ran with, and refuses while a BLOCK file is in the change. One with a
// LEAKY file prints it on stdout and stderr, as a hook printing what it read would, and refuses.
const hook = (name: string, extra = "") =>
  `#!/bin/sh\necho ${name} >> "${OUT}/hooks-ran.txt"\nenv > "${OUT}/hook-env.txt"\n${extra}[ -e BLOCK ] && { echo blocked >&2; exit 1; }\n` +
  `[ -e LEAKY ] && { cat LEAKY; [ -e OLD ] && cat OLD; echo "hook refused: a finding in LEAKY"; cat LEAKY >&2; echo "hook refused on stderr" >&2; exit 1; }\nexit 0\n`;
const SUPER = join(T, "super");
const CLONES = join(T, "clones");

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: `0 walk rows record a clone made at ${cwd}` };
const clone = async (repo: string): Promise<string> => {
  const w = await makeWorktree(repo);
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  asOwner(w.cwd);
  return w.cwd;
};

beforeAll(() => {
  Object.assign(process.env, { DISCOVERY_ENDPOINT: "http://discovery.test", GITHUB_PUSH_TOKEN: PAT, SUPER_REPO_DIR: SUPER, MITOSIS_PUSH_CLONE_DIR: CLONES, WALK_TREES_DIR: join(T, "trees") });
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  writeFileSync(join(SUPER, "scripts", "git-hooks", "pre-commit"), hook("super-hook"), { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", "vessel-pre-commit"), hook("vessel-hook", "echo 'note: gitleaks not installed; secrets scan skipped.'\n"), { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), 'title = "t"\n\n[extend]\nuseDefault = true\n');
  // The USER's protected list at the super base: a commit is judged against it (git-land.test.ts covers what it names).
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/"] } }) + "\n");
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

  // records, stubbed as records answers: selections name their request (root, and the root in pool_refs, which is how
  // records' episode finds them), and the walk's hops carry its writer. It counts the bytes it sends.
  const stubRecords = () => {
    const rows: Array<Record<string, unknown>> = [];
    const st = { open: [] as string[], down: false, bytes: 0, reads: [] as string[] };
    const sel = (id: string, root: string) => rows.push({ id, shape: "selection", role: "walk", writer: "walk-1", root, pool_refs: [root], cands: "x".repeat(40_000) });
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      if ((init?.headers as Record<string, string> | undefined)?.Authorization !== "ApiKey test-node-key") return new Response("no key", { status: 401 });
      if (st.down) return new Response("down", { status: 503 });
      const p = JSON.parse(String(init?.body)).pointer;
      st.reads.push(JSON.stringify({ ...p, type: undefined }));
      const body = p.episode !== undefined && Array.isArray(p.calls) ? callsRead(rows, st.open, p.calls)
        : p.episode !== undefined ? episodeRead(rows, String(p.episode), st.open)
        : p.shape === "arm" ? [{ id: "arm-1", shape: "arm", role: "owner", vessel_id: "walk-1" }]
        : recordRead(rows, p);
      const text = JSON.stringify(body);
      st.bytes += text.length;
      return new Response(text, { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const ask = async (s?: string) => {
      const w = await makeWorktree("demo", process.env, s);
      if ("error" in w) throw new Error(w.error);
      // the walk records the whole answer in its ended hop (refreshed_from included, when a clone was brought to a new base)
      if (s) rows.push(...walkCall(String(rows.length), "git_worktree", s, { ...w }).map((h) => ({ ...h, writer: "walk-1", seq: rows.length + 1 })));
      return w;
    };
    return { rows, st, sel, ask };
  };

  it("[MUST-FAIL] two open requests never share a clone; a request gets its own clone again, and a closed one's unchanged clone", async () => {
    const trees = join(T, "trees");
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    for (const [id, root] of [["sel-a", "R-A"], ["sel-a2", "R-A"], ["sel-b", "R-B"], ["sel-b2", "R-B"], ["sel-c", "R-C"], ["sel-d", "R-D"]]) sel(id, root);
    st.open = ["R-A", "R-B", "R-C", "R-D"];
    const cwd = async (s?: string) => (await ask(s)).cwd;
    const a = await cwd("sel-a");
    const b = await cwd("sel-b");
    expect(b).not.toBe(a); // two open requests: two clones
    expect(await cwd("sel-a2")).toBe(a); // the same request: its own clone again
    expect(await cwd("sel-b2")).toBe(b);
    st.open = ["R-B", "R-C", "R-D"]; // R-A closes: its unchanged clone may go to another request
    expect(await cwd("sel-c")).toBe(a);
    writeFileSync(join(b, "edit.txt"), "x\n"); // a change is its request's work: it goes back to that request, as recorded
    const again = await ask("sel-b2");
    expect(again.cwd).toBe(b);
    expect(readFileSync(join(again.cwd, "edit.txt"), "utf8")).toBe("x\n");
    st.open = ["R-D"]; // R-B closes: a changed clone never goes to another request
    expect(await cwd("sel-d")).not.toBe(b);
    // nothing read, nothing shared: no selection named, or records down, gets a fresh clone
    const before = readdirSync(trees).length;
    await ask(undefined);
    st.down = true;
    await ask("sel-a");
    st.down = false;
    expect(readdirSync(trees).length).toBe(before + 2);
    // without the node key records refuses every read, and nothing is shared: a fresh clone (a pin)
    delete process.env.METABOB_API_KEY;
    expect(await cwd("sel-a2")).not.toBe(a);
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a handout reads only the calls: what the selections saw, of the asking request or any other, adds no bytes", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { rows, st, sel, ask } = stubRecords();
    sel("sel-x", "R-X");
    st.open = ["R-X"];
    await ask("sel-x");
    const measure = async () => { st.bytes = 0; st.reads = []; await ask("sel-x"); return st.bytes; };
    const quiet = await measure();
    // the open request itself works on: 100 more of its selections (40 KB each, as live ones run), and the calls they made
    for (let i = 0; i < 100; i++) {
      sel(`x-${i}`, "R-X");
      rows.push(...walkCall(`x-${i}`, "fs_read", `x-${i}`, { content: "y".repeat(8_000) }).map((h) => ({ ...h, writer: "walk-1" })));
    }
    // and 200 requests now closed, with their selections and their reads
    for (let i = 0; i < 200; i++) {
      sel(`old-${i}`, `R-old-${i}`);
      rows.push(...walkCall(`old-${i}`, "fs_read", `old-${i}`, { content: "y".repeat(8_000) }).map((h) => ({ ...h, writer: "walk-1" })));
    }
    const busy = await measure();
    expect(st.reads.some((r) => JSON.parse(r).shape === "selection" && JSON.parse(r).ids === undefined)).toBe(false); // never every selection
    expect(busy).toBeLessThan(quiet + 2_000); // flat: what the selections saw is never read
    // the calls that hand out clones are read: each adds what its answer holds, a few hundred bytes
    for (let i = 0; i < 50; i++) {
      rows.push(...walkCall(`wt-${i}`, "git_worktree", `old-${i}`, { cwd: `/nowhere/${i}`, repo: "demo", branch: "dev", base: "a".repeat(40), origin_url: "https://example.invalid/demo.git" }).map((h) => ({ ...h, writer: "walk-1" })));
    }
    expect(await measure()).toBeLessThan(busy + 50 * 400);
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a records that answers the episode's rows instead of calls hands no clone out again: a fresh one is made", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { rows, st, sel, ask } = stubRecords();
    sel("sel-p", "R-P"); sel("sel-q", "R-Q");
    st.open = ["R-P", "R-Q"];
    const p = await ask("sel-p"); // R-P's clone, unchanged
    const answering = globalThis.fetch;
    globalThis.fetch = (async (u: unknown, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).pointer;
      return Array.isArray(q.calls) ? Response.json(rows) : answering(u as string, init);
    }) as typeof fetch;
    const q = await ask("sel-q");
    globalThis.fetch = realFetch;
    expect(q.cwd).not.toBe(p.cwd); // never another open request's clone
  });

  it("[MUST-FAIL] a clone two open requests both hold goes back to neither, as it is or brought to a new base", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { rows, st, sel, ask } = stubRecords();
    for (const [id, root] of [["sel-s", "R-S"], ["sel-s2", "R-S"], ["sel-t", "R-T"], ["sel-t2", "R-T"], ["sel-s3", "R-S"]]) sel(id, root);
    st.open = ["R-S", "R-T"];
    const shared = await ask("sel-s");
    // a second open request is recorded as holding the same clone (as before the handout checked)
    rows.push(...walkCall("shared-t", "git_worktree", "sel-t", { ...shared }).map((h) => ({ ...h, writer: "walk-1", seq: rows.length + 1 })));
    expect((await ask("sel-s2")).cwd).not.toBe(shared.cwd); // not handed back as it is
    expect((await ask("sel-t2")).cwd).not.toBe(shared.cwd);
    const demo = join(CLONES, "demo");
    writeFileSync(join(demo, "c.txt"), "three\n");
    commitAll(demo, "another push"); // the copy moves on: not brought to the new base under the other request either
    const moved = await ask("sel-s3");
    expect(moved.cwd).not.toBe(shared.cwd);
    expect(g(shared.cwd, "rev-parse", "HEAD")).toBe(shared.base); // the shared clone is untouched
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] once the copy has moved on, a request's own clone is brought to the new tip in place, unchanged or carrying an edit the new tip did not touch", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-e", "R-E"], ["sel-e2", "R-E"], ["sel-f", "R-F"], ["sel-f2", "R-F"]]) sel(id, root);
    st.open = ["R-E", "R-F"];
    const e = await ask("sel-e"); // R-E's clone, which it then changes
    writeFileSync(join(e.cwd, "edit.txt"), "x\n");
    const f = await ask("sel-f"); // R-F's clone, left unchanged
    writeFileSync(join(demo, "b.txt"), "two\n");
    commitAll(demo, "a push landed"); // the copy moves on
    const tip = g(demo, "rev-parse", "HEAD");
    // each case on its own line: the changed clone, then the unchanged one
    const trees = join(T, "trees");
    const before = readdirSync(trees).length;
    const got: string[] = [];
    const answers: Record<string, unknown>[] = [];
    for (const [s, old, what] of [["sel-e2", e, "changed"], ["sel-f2", f, "unchanged"]] as const) {
      const w = await ask(s);
      answers.push(w as unknown as Record<string, unknown>);
      got.push(`${what}: ${w.cwd !== old.cwd ? "new clone" : "same clone"}, base ${w.base === tip ? "tip" : "old"}, HEAD ${g(w.cwd, "rev-parse", "HEAD") === tip ? "tip" : "old"}`);
    }
    // the changed clone's edit (edit.txt) is not a path the push changed (b.txt), so it is carried in place too
    expect(got).toEqual(["changed: same clone, base tip, HEAD tip", "unchanged: same clone, base tip, HEAD tip"]);
    expect(answers[0]).toMatchObject({ refreshed_from: e.base, carried: "uncommitted" });
    expect(readFileSync(join(e.cwd, "edit.txt"), "utf8")).toBe("x\n"); // the edit is still there
    expect(answers[1].refreshed_from).toBe(f.base); // says which base it moved from
    expect(answers[1].carried).toBeUndefined(); // nothing to carry: as before
    expect(readdirSync(trees).length).toBe(before); // no fresh clone was made
    // a commit in the refreshed clone reads its rows as one clone, at the new base
    const madeThere = await madeClone(f.cwd);
    expect("error" in madeThere ? madeThere.error : madeThere.base).toBe(tip);
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a change the new tip also changed is not carried: the clone is left exactly as it was, and the answer names the paths beside a fresh clone", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-k", "R-K"], ["sel-k2", "R-K"]]) sel(id, root);
    st.open = ["R-K"];
    const k = await ask("sel-k");
    writeFileSync(join(k.cwd, "a.txt"), "mine\n"); // the request's uncommitted edit of a.txt
    asOwner(k.cwd)
    writeFileSync(join(demo, "a.txt"), "theirs\n");
    commitAll(demo, "a push changing a.txt too");
    const tip = g(demo, "rev-parse", "HEAD");
    const w = await ask("sel-k2");
    expect(w.cwd).not.toBe(k.cwd); // a fresh clone
    expect(w.base).toBe(tip);
    expect((w as unknown as Record<string, unknown>).not_carried).toMatchObject({ cwd: k.cwd, from: k.base, conflicts: ["a.txt"] });
    expect(g(k.cwd, "rev-parse", "HEAD")).toBe(k.base); // the old clone did not move
    expect(readFileSync(join(k.cwd, "a.txt"), "utf8")).toBe("mine\n"); // and its edit is untouched
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] the request's commits are replayed onto the new tip when it changed none of their paths; a conflicting replay is undone", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-m", "R-M"], ["sel-m2", "R-M"], ["sel-n", "R-N"], ["sel-n2", "R-N"]]) sel(id, root);
    st.open = ["R-M", "R-N"];
    const m = await ask("sel-m");
    writeFileSync(join(m.cwd, "m.txt"), "m\n"); commitAll(m.cwd, "m's change"); // commits a path the push won't touch
    const n = await ask("sel-n");
    writeFileSync(join(n.cwd, "c.txt"), "n\n"); commitAll(n.cwd, "n's change"); // commits a path the push will touch
    asOwner(m.cwd); asOwner(n.cwd)
    const nHead = g(n.cwd, "rev-parse", "HEAD");
    writeFileSync(join(demo, "c.txt"), "push\n");
    commitAll(demo, "a push changing c.txt");
    const tip = g(demo, "rev-parse", "HEAD");
    const wm = await ask("sel-m2") as unknown as Record<string, unknown>;
    expect(wm).toMatchObject({ cwd: m.cwd, base: tip, refreshed_from: m.base, carried: "commits" });
    expect(g(m.cwd, "merge-base", "--is-ancestor", tip, "HEAD")).toBe(""); // on the new tip
    expect(g(m.cwd, "log", "-1", "--format=%s")).toBe("m's change"); // its commit, replayed
    expect(readFileSync(join(m.cwd, "c.txt"), "utf8")).toBe("push\n"); // and the push's change under it
    const wn = await ask("sel-n2") as unknown as Record<string, unknown>;
    expect(wn.cwd).not.toBe(n.cwd);
    expect(wn.not_carried).toMatchObject({ cwd: n.cwd, conflicts: ["c.txt"] });
    expect(g(n.cwd, "rev-parse", "HEAD")).toBe(nHead); // the conflicting clone is left exactly as it was
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a carried change is a new tree: nothing judged on the old one (its diff, typecheck, verdict) is about it", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-v", "R-V"], ["sel-v2", "R-V"]]) sel(id, root);
    st.open = ["R-V"];
    const v = await ask("sel-v");
    writeFileSync(join(v.cwd, "v.txt"), "v\n"); commitAll(v.cwd, "v's change"); asOwner(v.cwd)
    const judged = g(v.cwd, "rev-parse", "HEAD^{tree}"); // the tree a diff, typecheck and verdict were made of
    writeFileSync(join(demo, "d.txt"), "d\n"); commitAll(demo, "a push");
    await ask("sel-v2");
    // git_land takes a verdict only on the tree it lands (approved(…, tree)): the carried tree is another
    expect(g(v.cwd, "rev-parse", "HEAD^{tree}")).not.toBe(judged);
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a replay a restart cut off (the clone left mid-rebase) is undone, and the change is carried or named, never dropped", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-r", "R-R"], ["sel-r2", "R-R"]]) sel(id, root);
    st.open = ["R-R"];
    const r = await ask("sel-r");
    writeFileSync(join(r.cwd, "c.txt"), "r\n"); commitAll(r.cwd, "r's change"); asOwner(r.cwd)
    const rHead = g(r.cwd, "rev-parse", "HEAD");
    writeFileSync(join(demo, "c.txt"), "push2\n"); commitAll(demo, "a push changing c.txt");
    const tip = g(demo, "rev-parse", "HEAD");
    // the replay a restart cut off: fetched, started, stopped on its conflict, never undone
    g(r.cwd, "fetch", "--quiet", demo, "HEAD");
    try { g(r.cwd, "rebase", "--quiet", "--onto", tip, r.base); } catch { /* the conflict, left as it is */ }
    asOwner(r.cwd) // made here as the test's user: handed to the clone's owner, as every walk-tree git runs as it
    expect(existsSync(join(r.cwd, ".git", "rebase-merge")) || existsSync(join(r.cwd, ".git", "rebase-apply"))).toBe(true)
    const w = await ask("sel-r2") as unknown as Record<string, unknown>;
    expect(w.not_carried).toMatchObject({ cwd: r.cwd, conflicts: ["c.txt"] }); // named, beside a fresh clone
    expect(g(r.cwd, "rev-parse", "HEAD")).toBe(rHead); // undone: back on its branch, its commit there
    globalThis.fetch = realFetch;
  });

  it("[MUST-FAIL] a clone left off its own branch, holding commits, is named in the answer, not dropped in silence", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-o", "R-O"], ["sel-o2", "R-O"]]) sel(id, root);
    st.open = ["R-O"];
    const o = await ask("sel-o");
    writeFileSync(join(o.cwd, "o.txt"), "o\n"); commitAll(o.cwd, "o's change"); asOwner(o.cwd)
    g(o.cwd, "checkout", "--quiet", "--detach"); // off its branch (an undo that could not run would leave it so)
    asOwner(o.cwd)
    writeFileSync(join(demo, "f.txt"), "f\n"); commitAll(demo, "a push");
    const w = await ask("sel-o2") as unknown as Record<string, unknown>;
    expect(w.cwd).not.toBe(o.cwd);
    expect(w.not_carried).toMatchObject({ cwd: o.cwd });
    globalThis.fetch = realFetch;
  });

  it("a clone holding both commits and uncommitted edits is not carried, and says so", async () => {
    process.env.METABOB_API_KEY = "test-node-key";
    const { st, sel, ask } = stubRecords();
    const demo = join(CLONES, "demo");
    for (const [id, root] of [["sel-b", "R-B"], ["sel-b2", "R-B"]]) sel(id, root);
    st.open = ["R-B"];
    const b = await ask("sel-b");
    writeFileSync(join(b.cwd, "x.txt"), "x\n"); commitAll(b.cwd, "b's commit");
    writeFileSync(join(b.cwd, "y.txt"), "y\n"); // and an uncommitted edit
    asOwner(b.cwd)
    writeFileSync(join(demo, "e.txt"), "e\n"); commitAll(demo, "a push");
    const w = await ask("sel-b2") as unknown as Record<string, unknown>;
    expect(w.cwd).not.toBe(b.cwd);
    expect(String((w.not_carried as { why: string }).why)).toContain("both");
    globalThis.fetch = realFetch;
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
    asOwner(cwd);
    writeFileSync(join(cwd, "BLOCK"), "x\n");
    const r = await commitInClone(cwd, "weaken the gate", undefined, find);
    expect("error" in r && r.error).toContain("refused");
    // what the hook said is kept only when it could be scanned; with no scanner on the node it is withheld
    if (Bun.which("gitleaks")) expect("stderr" in r && r.stderr).toContain("blocked");
    else expect("stderr_withheld" in r && r.stderr_withheld).toContain("no secrets scanner");
  });

  // Key-shaped values, built so that no scanner reads this file as holding one.
  const ADDED = "AKIA" + "Z7Q4LX2M9WB3N8PD";
  const IN_TREE = "AKIA" + "Q2W8E4R6T1Y3U5I7";
  const refuse = async (leaky: string, opts: { old?: string; scanner?: string | null } = {}) => {
    if (opts.old !== undefined) { writeFileSync(join(CLONES, "demo", "OLD"), opts.old); commitAll(join(CLONES, "demo"), "a file already in the tree"); }
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "LEAKY"), leaky);
    const r = await commitInClone(cwd, "plant a value", undefined, find, opts.scanner === undefined ? Bun.which("gitleaks") : opts.scanner);
    if (opts.old !== undefined) { rmSync(join(CLONES, "demo", "OLD")); commitAll(join(CLONES, "demo"), "the file gone again"); }
    expect("error" in r && r.error).toContain("refused");
    return r as { stderr?: string; stderr_withheld?: string };
  };
  // A scanner that names one line, whatever it is given, and always finds it: line 0 is past nothing, a large one past the end.
  const stub = (line: number): string => {
    const at = join(T, `stub-scanner-${line}`);
    writeFileSync(at, `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "--report-path" ] && R="$2"; shift; done\n` +
      `printf '[{"RuleID":"stub","StartLine":${line},"EndLine":${line}}]' > "$R"\nexit 3\n`, { mode: 0o755 });
    return at;
  };

  it("the secrets scanner these tests need is on PATH: without it the redaction tests would prove nothing", () => {
    expect(Bun.which("gitleaks")).not.toBeNull();
  });

  it("[MUST-FAIL] a refused commit says what the hook printed (its stdout and stderr both), cut short, without a key the change added", async () => {
    const r = await refuse(`${"x".repeat(5000)}\naws_key=${ADDED}\nshort=abc\n`);
    const said = r.stderr ?? "";
    expect(said.length).toBeLessThanOrEqual(2000);
    expect(said).not.toContain(ADDED);
    expect(said).toContain("[REDACTED: secrets scan, rules aws-access-token]");
    expect(said).toContain("short=abc");
    expect(said).toContain("hook refused on stderr"); // the end of what it printed: where a hook gives its verdict
  });

  it("[MUST-FAIL] a key in a file already in the tree, printed by the hook, is not in the answer", async () => {
    const r = await refuse("a line\n", { old: `old_key=${IN_TREE}\n` });
    expect(r.stderr ?? "").not.toContain(IN_TREE);
    expect(r.stderr).toContain("[REDACTED: secrets scan");
  });

  it("[MUST-FAIL] any value this vessel holds that an agent's shell is not given, printed by the hook, is not in the answer", async () => {
    // a name no list carries: what is withheld from the shell is what is redacted here, whatever it is called
    const name = "SOME_PROVIDER_" + "SECRET_OF_THIS_TEST";
    const own = "node-credential-value-" + "4f1c9a7e2b";
    process.env[name] = own;
    try {
      const r = await refuse(`the key is ${own} here\n`);
      expect(r.stderr ?? "").not.toContain(own);
      expect(r.stderr).toContain("[REDACTED]");
    } finally { delete process.env[name]; }
  });

  it("[MUST-FAIL] a value that is a place (a path, a URL without credentials) keeps a failure's file and line; a token beside it does not stay", async () => {
    const set: Record<string, string> = {
      ["WORK" + "SPACE_ROOT_OF_THIS_TEST"]: "/workspace",
      ["SHELL_" + "OF_THIS_TEST"]: "/bin/bash",
      ["ENDPOINT_" + "OF_THIS_TEST"]: "http://127.0.0.1:8100",
      ["TOKEN_" + "OF_THIS_TEST"]: "tok-" + "9b2e7c41d0a8f6",
      ["CRED_URL_" + "OF_THIS_TEST"]: "https://" + "user:pw-" + "77aa31c9@example.invalid/x",
      ["QUERY_URL_" + "OF_THIS_TEST"]: "https://h/x?token=" + "q-5d0e9a2b7c13",
      ["HOOK_URL_" + "OF_THIS_TEST"]: "https://hooks.example/services/T0/B0/" + "w3bh00k5ecr3tT0k3nAbCdEf",
    };
    Object.assign(process.env, set);
    try {
      const failing = "src/x.ts(12,3): error TS2304: Cannot find name 'y' at /workspace/git/walk-trees/t/src/x.ts:12 via /bin/bash http://127.0.0.1:8100/health";
      const r = await refuse(`${failing}\nwith ${set["TOKEN_" + "OF_THIS_TEST"]} and pw-77aa31c9 and q-5d0e9a2b7c13 and ${set["HOOK_URL_" + "OF_THIS_TEST"]}\n`);
      expect(r.stderr).toContain("/workspace/git/walk-trees/t/src/x.ts:12");
      expect(r.stderr).toContain("/bin/bash");
      expect(r.stderr).toContain("http://127.0.0.1:8100/health");
      expect(r.stderr ?? "").not.toContain("9b2e7c41d0a8f6");
      expect(r.stderr ?? "").not.toContain("pw-77aa31c9");
      expect(r.stderr ?? "").not.toContain("q-5d0e9a2b7c13");
      expect(r.stderr ?? "").not.toContain("w3bh00k5ecr3tT0k3nAbCdEf"); // a webhook's secret rides in its path
    } finally { for (const k of Object.keys(set)) delete process.env[k]; }
  });

  it("[MUST-FAIL] a finding the scan places outside the text withholds everything", async () => {
    const r = await refuse(`aws_key=${ADDED}\n`, { scanner: stub(9999) });
    expect(r.stderr).toBeUndefined();
    expect(r.stderr_withheld).toContain("could not place");
  });

  it("[MUST-FAIL] a finding the scan places on the wrong line is caught by scanning the replaced text again: withheld", async () => {
    // the stub names line 1 every time; the key the hook prints is on a later line, so it survives the first replace
    const r = await refuse(`first line\naws_key=${ADDED}\n`, { scanner: stub(1) });
    expect(r.stderr).toBeUndefined();
    expect(r.stderr_withheld).toContain("still found");
    expect(JSON.stringify(r)).not.toContain(ADDED);
  });

  it("[MUST-FAIL] a long name the change added stays readable, and both of the hook's streams are said", async () => {
    const r = await refuse("const someVeryLongIdentifierName = 1\nsrc/a.ts(3,1): error TS2304: Cannot find name 'someVeryLongIdentifierName'.\n");
    expect(r.stderr).toContain("Cannot find name 'someVeryLongIdentifierName'");
    expect(r.stderr).toContain("hook refused: a finding in LEAKY"); // what the hook printed on its stdout
    expect(r.stderr).toContain("hook refused on stderr"); // and on its stderr
  });

  it("[MUST-FAIL] when the scan cannot run, nothing the hook printed is kept: it is withheld and said why", async () => {
    // none on the node; one that cannot start; one that runs and fails (exits 1, neither clean nor a finding)
    for (const scanner of [null, "/nonexistent/gitleaks", "/bin/false"]) {
      const r = await refuse(`aws_key=${ADDED}\n`, { scanner });
      expect(r.stderr).toBeUndefined();
      expect(typeof r.stderr_withheld).toBe("string");
      expect(JSON.stringify(r)).not.toContain(ADDED);
    }
  });

  it("[MUST-FAIL] the commit and its hook run without this vessel's credentials", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "three\n");
    expect("sha" in (await commitInClone(cwd, "an ordinary change", undefined, find))).toBe(true);
    const seen = readFileSync(join(OUT, "hook-env.txt"), "utf8");
    expect(seen).toContain("PATH=");
    expect(seen).not.toContain(PAT);
    expect(seen).not.toContain("GITHUB_PUSH_TOKEN");
  });

  it("[MUST-FAIL] takes the base from the walk's row: a commit slipped into the clone is still judged", async () => {
    const cwd = await clone("demo");
    mkdirSync(join(cwd, "scripts", "substrate", "gate"), { recursive: true });
    writeFileSync(join(cwd, "scripts", "substrate", "gate", "x.sh"), "x\n");
    commitAll(cwd, "slipped in by hand"); // the clone's own HEAD now carries the gate change
    asOwner(cwd)
    writeFileSync(join(cwd, "a.txt"), "four\n");
    const r = await commitInClone(cwd, "an ordinary-looking change", undefined, find);
    if (!("sha" in r)) throw new Error(JSON.stringify(r));
    expect(r.base).toBe(made.get(cwd)!.base);
    expect(r.changed.sort()).toEqual(["a.txt", "scripts/substrate/gate/x.sh"]);
    expect(r.needs_person).toEqual(["scripts/substrate/gate/x.sh"]);
    expect(r.tree).toBe(g(cwd, "rev-parse", "HEAD^{tree}"));
  });

  it("[MUST-FAIL] a clone no walk row names, rows naming different clones there, or one that has landed, is refused", async () => {
    const cwd = await clone("demo");
    writeFileSync(join(cwd, "a.txt"), "five\n");
    // the walk's call rows, as the walk writes them (started names the shape; ended carries the output, not the shape)
    const call = (n: string, type: string, output: object, extra: Record<string, unknown> = {}) =>
      walkCall(n, type, `sel-${n}`, output as Record<string, unknown>).map((r) => ({ ...r, ...extra }));
    const answer = (rows: Array<Record<string, unknown>>) => {
      globalThis.fetch = (async (_u: unknown, init?: RequestInit) => Response.json(recordRead(rows, JSON.parse(String(init?.body)).pointer))) as typeof fetch;
    };
    const w = made.get(cwd)!;
    answer([]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no walk row");
    answer([...call("1", "git_worktree", w), ...call("2", "git_worktree", { ...w, base: "0".repeat(40) })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("2 walk rows record different clones");
    answer(call("1", "git_worktree", w, { role: "person" }));
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no walk row");
    // the same clone handed out twice: both rows agree, and the later one's super_base holds
    // a refresh moves one clone's base, and says from which: its rows read as one clone, at the newest base
    answer([...call("1", "git_worktree", w, { seq: 1 }), ...call("2", "git_worktree", { ...w, base: "1".repeat(40), refreshed_from: w.base }, { seq: 2 })]);
    expect((await madeClone(cwd) as { base: string }).base).toBe("1".repeat(40));
    // a refresh claiming a base the rows never held is a collision still
    answer([...call("1", "git_worktree", w, { seq: 1 }), ...call("2", "git_worktree", { ...w, base: "1".repeat(40), refreshed_from: "2".repeat(40) }, { seq: 2 })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("different clones");
    answer([...call("1", "git_worktree", w, { seq: 1 }), ...call("2", "git_worktree", { ...w, super_base: "f".repeat(40) }, { seq: 2 })]);
    expect(await madeClone(cwd)).toEqual({ cwd, repo: "demo", branch: "dev", base: w.base, super_base: "f".repeat(40), origin_url: w.origin_url });
    answer([...call("1", "git_worktree", w), ...call("3", "git_land", { cwd })]);
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("already landed");
    delete process.env.DISCOVERY_ENDPOINT;
    expect(String((await madeClone(cwd) as { error: string }).error)).toContain("no discovery endpoint");
    process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
    answer(call("1", "git_worktree", w));
    expect(await madeClone(cwd)).toEqual({ cwd, repo: "demo", branch: "dev", base: w.base, super_base: w.super_base, origin_url: w.origin_url });
    globalThis.fetch = realFetch;
    expect(String((await commitInClone(join(T, "not-made"), "x", undefined, find) as { error: string }).error)).toContain("0 walk rows");
  });

  it("a vessel change runs the vessel hook and a super-repo change the super hook; a skipped secrets scan is reported", async () => {
    const before = existsSync(join(OUT, "hooks-ran.txt")) ? readFileSync(join(OUT, "hooks-ran.txt"), "utf8").split("\n").length : 1;
    const v = await clone("demo");
    writeFileSync(join(v, "a.txt"), "six\n");
    const rv = await commitInClone(v, "vessel change", undefined, find);
    const s = await clone("super");
    writeFileSync(join(s, "README.md"), "x\n");
    const rs = await commitInClone(s, "super change", undefined, find);
    const ran = readFileSync(join(OUT, "hooks-ran.txt"), "utf8").split("\n").slice(before - 1).filter(Boolean);
    expect(ran).toEqual(["vessel-hook", "super-hook"]);
    expect("scan" in rv && rv.scan).toBe("skipped");
    expect("scan" in rs && rs.scan).toBe("ran");
  });

  // The super-repo hook reads its scan config from beside itself, as the real one does: missing, the scan cannot run,
  // and the real hook reports that as secrets found. Each case swaps the super base's hook and puts the fixture's back.
  const withSuperHook = async (text: string, fn: () => Promise<void>) => {
    const path = join(SUPER, "scripts", "git-hooks", "pre-commit");
    const keep = readFileSync(path, "utf8");
    writeFileSync(path, text, { mode: 0o755 }); commitAll(SUPER, "super hook for a case");
    try { await fn(); } finally { writeFileSync(path, keep, { mode: 0o755 }); commitAll(SUPER, "fixture hook back"); }
  };

  it("[MUST-FAIL] the super hook finds its scan config beside it, so a clean super commit is not refused as a leak", async () => {
    await withSuperHook('#!/bin/sh\n[ -f "$(dirname "$0")/.gitleaks.toml" ] || { echo "gitleaks: secrets detected in staged diff"; exit 1; }\nexit 0\n', async () => {
      const s = await clone("super");
      writeFileSync(join(s, "clean.md"), "nothing secret\n");
      const r = await commitInClone(s, "clean super change", undefined, find);
      expect("sha" in r ? "committed" : JSON.stringify(r)).toBe("committed");
    });
  });

  const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
  it(SCANNER ? "[MUST-FAIL] a real secret in a super commit is still refused by the pinned hook's scan"
    : "[MUST-FAIL] a real secret in a super commit is still refused (no gitleaks here: not run)", async () => {
    if (!SCANNER) return;
    // The fixture's config at the super base has no project rule; the scan uses gitleaks' default rules beside it.
    await withSuperHook('#!/bin/sh\ngitleaks protect --staged --redact --no-banner --config "$(dirname "$0")/.gitleaks.toml" >/dev/null 2>&1 || { echo "gitleaks: secrets detected in staged diff"; exit 1; }\nexit 0\n', async () => {
      const s = await clone("super");
      const secret = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0", "K1l2M3n4O5p6Q7r8S9t0"].join("");
      writeFileSync(join(s, "leak.env"), `TOKEN=${secret}\n`);
      const r = await commitInClone(s, "a leak", undefined, find);
      expect("error" in r && String(r.error)).toContain("refused");
    });
  });

  it("[MUST-FAIL] keeps the node's record-only hooks, but never its pre-commit, which would chain to the clone's own", async () => {
    const ledger = mkdtempSync(join(tmpdir(), "ledger-hooks-"));
    writeFileSync(join(ledger, "post-commit"), `#!/bin/sh\necho recorded >> "${OUT}/ledger.txt"\n`, { mode: 0o755 });
    writeFileSync(join(ledger, "pre-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const sys = join(T, "gitconfig-system");
    writeFileSync(sys, `[core]\n\thooksPath = ${ledger}\n`);
    const keep = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
    try {
      const cwd = await clone("demo");
      writeFileSync(join(cwd, "a.txt"), "eight\n");
      expect("sha" in (await commitInClone(cwd, "recorded", undefined, find))).toBe(true);
      expect(readFileSync(join(OUT, "ledger.txt"), "utf8")).toContain("recorded");
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
