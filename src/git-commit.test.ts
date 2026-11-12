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

// Each hook records which one ran and the env it ran with, and refuses while a BLOCK file is in the change.
const hook = (name: string, extra = "") =>
  `#!/bin/sh\necho ${name} >> "${OUT}/hooks-ran.txt"\nenv > "${OUT}/hook-env.txt"\n${extra}[ -e BLOCK ] && { echo blocked >&2; exit 1; }\nexit 0\n`;
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
      if (s) rows.push(...walkCall(String(rows.length), "git_worktree", s, { cwd: w.cwd, repo: w.repo, branch: w.branch, base: w.base, origin_url: w.origin_url }).map((h) => ({ ...h, writer: "walk-1" })));
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

  it("[MUST-FAIL] once the copy has moved on, a request's own clone, changed or not, is not handed back: a clone at the new tip is", async () => {
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
    const got: string[] = [];
    for (const [s, old, what] of [["sel-e2", e, "changed"], ["sel-f2", f, "unchanged"]] as const) {
      const w = await ask(s);
      got.push(`${what}: ${w.cwd !== old.cwd ? "new clone" : "same clone"}, base ${w.base === tip ? "tip" : "old"}, HEAD ${g(w.cwd, "rev-parse", "HEAD") === tip ? "tip" : "old"}`);
    }
    expect(got).toEqual(["changed: new clone, base tip, HEAD tip", "unchanged: new clone, base tip, HEAD tip"]);
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
    expect("stderr" in r && r.stderr).toContain("blocked");
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
