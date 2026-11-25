// git_land pushes a clone's change only when a verdict row approves its exact tree, the secrets scan is clean and it
// fast-forwards origin; every check runs in a repository of its own. Throwaway repositories; records is an in-memory
// table; origin is a local bare repository, so the file transport is allowed for these tests only.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout, spyOn } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone } from "./git-commit";
import { diffClone, gapOf, landClone, passedIn, suiteCheck, suiteRefuses } from "./git-land";
import type { Trusted, Typecheck } from "./git-land";
import { makeWorktree } from "./git-worktree";
import type { Made, Query, Row } from "./walk-rows";

// Run as root, git in the code under test drops to the shell user (shell-privilege.ts), which must read these
// fixtures: the test root is opened up, and what hooks write goes to a directory anyone may write.
// Each case makes clones, bundles and checks, and a diff now runs the compiler and a test run on its tree: several
// seconds apiece on a loaded node (a gate runs suites side by side), past bun's default 5 s per test.
setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "git-land-test-"));
chmodSync(T, 0o755);
const OUT = join(T, "out");
mkdirSync(OUT);
chmodSync(OUT, 0o777);
const ENV_KEYS = ["SUPER_REPO_DIR", "PULLSYNC_GATE_PUBLIC_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_RUNTIME_DIR", "WALK_TREES_DIR", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "PATH"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
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
const SUPER = join(T, "super");
const ORIGIN = join(T, "demo.git");
const COPY = join(T, "clones", "demo");
const CONFIG = 'title = "t"\n\n[extend]\nuseDefault = true\n\n[[rules]]\nid = "substrate-api-key"\nregex = \'\'\'\\bmb[-_][A-Za-z0-9_-]{32,}\'\'\'\n';

const SCOPE = (excluded: string[]) => JSON.stringify({ autonomyScope: { excluded_paths: excluded } }) + "\n";
// The gate-public dir pull-sync publishes on a node: its marker names the super commit the gate accepted (gated) or
// vouches for the super clone's committed HEAD (ungated). An ungated node's marker by default; a leg names another.
const GATE_PUBLIC = join(T, "gate-public");
const UNGATED = { schema: 1, gated: false, source: "clone", accepted_sha: null };
const marker = (m: unknown) => writeFileSync(join(GATE_PUBLIC, "source.json"), typeof m === "string" ? m : JSON.stringify(m) + "\n");

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: "0 walk rows" };
let table: Row[] = [];
// the owner's repository row: demo takes landings on dev (a leg below changes it)
let repoRows: Row[] = [{ id: "repo-demo", seq: 1, shape: "repository", role: "owner", repo: "demo", branch: "dev" } as Row];
const rows = async (q: Query): Promise<Row[]> => [...repoRows, ...table].filter((r) =>
  (q.shape === undefined || r.shape === q.shape) && (q.ids === undefined || q.ids.includes(r.id)) &&
  Object.entries(q.where ?? {}).every(([k, v]) => String(r[k]) === String(v)));
const deps = { find, rows, transports: ["file"] };

/** A clone with one committed change; its tree. */
const change = async (file: string, text: string): Promise<{ cwd: string; tree: string }> => {
  g(COPY, "pull", "-q", "origin", "dev");
  const w = await makeWorktree("demo");
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  asOwner(w.cwd);
  mkdirSync(join(w.cwd, file, ".."), { recursive: true });
  writeFileSync(join(w.cwd, file), text);
  const c = await commitInClone(w.cwd, `change ${file}`, undefined, find);
  if (!("tree" in c)) throw new Error(JSON.stringify(c));
  return { cwd: w.cwd, tree: c.tree };
};
const originHead = () => g(ORIGIN, "rev-parse", "dev");
const ask = { id: "ask1", shape: "world_changed", role: "person" } as Row;
// What git_diff says of a tree that typechecks: a grader's verdict counts only from a diff that says so.
const TC_OK = { ran: true, passed: true, exit_code: 0, out: "", truncated: false };
// What git_diff says of a tree on which no test of the whole suite that passed on the base fails.
const SUITE_OK = { ran: true, passed: true, exit_code: 0, out: "", truncated: false, regressed: [] };
/** A person's r 1 on the walk's whole diff of a tree: the rows a person's approval is given on. */
const personOn = (tree: string, id: string, extra: Record<string, unknown> = {}): Row[] => [
  { id: `pd-${id}`, shape: "gitDiff", role: "walk", repo: "demo", tree, truncated: false, typecheck: TC_OK, suite: SUITE_OK } as Row,
  { id, shape: "land_verdict", repo: "demo", tree, role: "person", r: 1, input_refs: [`pd-${id}`], ...extra } as Row,
];

beforeAll(() => {
  mkdirSync(GATE_PUBLIC); marker(UNGATED);
  Object.assign(process.env, { SUPER_REPO_DIR: SUPER, PULLSYNC_GATE_PUBLIC_DIR: GATE_PUBLIC, MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), MITOSIS_RUNTIME_DIR: join(T, "runtime"), WALK_TREES_DIR: join(T, "trees") });
  // demo's install on this node: this vessel's own, which carries the TypeScript compiler
  mkdirSync(join(T, "runtime", "demo"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", "demo", "node_modules"));
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;
  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true });
  g(SUPER, "init", "-q", "-b", "dev");
  for (const h of ["pre-commit", "vessel-pre-commit"]) writeFileSync(join(SUPER, "scripts", "git-hooks", h), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), CONFIG);
  // The USER's protected list, committed at the super base: the node gate's directory, the operator's tooling, and a
  // directory of the demo vessel (named as the super-repo names it, repos/demo/...).
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), SCOPE(["scripts/substrate/", ".claude/", "repos/demo/protected/"]));
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  const seed = join(T, "seed");
  g(T, "clone", "-q", ORIGIN, seed);
  writeFileSync(join(seed, "a.txt"), "one\n");
  commitAll(seed, "base"); g(seed, "push", "-q", "origin", "HEAD:dev");
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, COPY);
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(T, { recursive: true, force: true });
});

// Every check below runs after the secrets scan, which needs gitleaks. On a node without it, git_land refuses before any
// of them: there, each case asserts that refusal (the node's real behaviour, itself a property that must hold) instead of
// a check it never reaches. Where gitleaks is present, the cases are exactly as written.
const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });
const scanned = (name: string, fn: () => Promise<void>) => it(SCANNER ? name : `${name} (no secrets scanner here: refused)`, SCANNER ? fn : async () => {
  const { cwd, tree } = await change(`noscan-${Math.random().toString(36).slice(2)}.txt`, "x\n");
  table = personOn(tree, "vp");
  const before = originHead();
  expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no secrets scanner");
  expect(originHead()).toBe(before);
});

describe("git_land's branch", () => {
  scanned("[MUST-FAIL] lands only on the branch the owner's repository row names: none named or retired refuses as the owner's gap, another refuses naming both", async () => {
    const before = originHead();
    const { cwd, tree } = await change("branch.txt", "b\n");
    table = personOn(tree, "vb");
    const saved = repoRows;
    try {
      repoRows = [];
      const none = await landClone(cwd, deps) as { error: string; unserved?: string };
      repoRows = [{ ...saved[0], retired: true } as Row];
      const retired = await landClone(cwd, deps) as { error: string; unserved?: string };
      repoRows = [{ ...saved[0], branch: "main" } as Row];
      const other = await landClone(cwd, deps) as { error: string; unserved?: string };
      repoRows = [{ ...saved[0], branch: "main" } as Row, { ...saved[0], id: "repo-demo-2", seq: 2, role: "described", branch: "dev" } as Row];
      const notOwner = await landClone(cwd, deps) as { error: string };
      // the NEWEST owner row decides: an older row naming dev does not outlive a newer one naming main
      repoRows = [saved[0], { ...saved[0], id: "repo-demo-newer", seq: 3, branch: "main" } as Row];
      const newer = await landClone(cwd, deps) as { error: string };
      expect([none.unserved, none.error]).toEqual(["repository", "no repository row names a working branch for demo: nothing lands"]);
      expect([retired.unserved, other.unserved, other.error]).toEqual(["repository", undefined, "the clone is on dev; demo takes landings on main only"]);
      expect(notOwner.error).toBe("the clone is on dev; demo takes landings on main only"); // only the owner's row names it
      expect(newer.error).toBe("the clone is on dev; demo takes landings on main only");
      expect(originHead()).toBe(before);
    } finally {
      repoRows = saved;
    }
  });
});

describe("git_land", () => {
  scanned("[MUST-FAIL] lands nothing without a verdict on its tree, nor with a verdict on another tree", async () => {
    const before = originHead();
    const { cwd, tree } = await change("a.txt", "two\n");
    table = [];
    const refused = await landClone(cwd, deps) as { error: string; clone?: Record<string, unknown> }
    expect(String(refused.error)).toContain("no verdict approves this tree");
    // refused: where the clone is now, as a row the walk records, so the next move is a diff of this tree
    expect(refused.clone).toMatchObject({ shape: "gitWorktree", cwd, tree })
    table = personOn("0".repeat(40), "v1");
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    expect(originHead()).toBe(before);
    table = personOn(tree, "v2");
    const r = await landClone(cwd, deps);
    if (!("pushed" in r)) throw new Error(JSON.stringify(r));
    expect(originHead()).toBe(r.head);
    expect(r.verdict_ref).toBe("v2");
  });

  scanned("[MUST-FAIL] a grader's r 1 lands only from exactly the request and the walk's gitDiff of this tree", async () => {
    const { cwd, tree } = await change("b.txt", "b\n");
    const diff = { id: "d1", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row;
    const other = { id: "x1", shape: "fileContent", role: "described" } as Row;
    table = [ask, diff, other, { id: "v3", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1", "x1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    table = [ask, diff, { id: "v4", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["x1", "d1"] }, other];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    // an owner's configuration row is not the request
    const channel = { id: "ch1", shape: "channel", role: "owner" } as Row;
    table = [ask, channel, { ...diff, input_refs: ["ch1"] }, { id: "v15", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ch1", "d1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    // a diff made for another request is not this request's change
    const ask2 = { id: "ask2", shape: "world_changed", role: "person" } as Row;
    table = [ask, ask2, { ...diff, input_refs: ["ask2"] }, { id: "v16", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true)
    // the diff the grader saw must say the tree typechecks: one saying it does not, or saying nothing, lands nothing
    for (const typecheck of [{ ...TC_OK, passed: false, exit_code: 2 }, undefined]) {
      table = [ask, { ...diff, typecheck }, { id: "v17", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d1"] }];
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("which says the tree typechecks");
    }
    table = [ask, diff, { id: "v5", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, writer: "described-x", input_refs: ["ask1", "d1"] }];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_ref).toBe("v5");
    expect("pushed" in r && r.verdict_by).toBe("described-x");
  });

  scanned("[MUST-FAIL] a person's r 1 counts only on the walk's whole diff of the tree", async () => {
    const { cwd, tree } = await change("p.txt", "p\n");
    const verdict = (refs: string[]) => ({ id: "vq", shape: "land_verdict", repo: "demo", tree, role: "person", r: 1, input_refs: refs } as Row);
    const forged = { id: "fd", shape: "gitDiff", role: "person", repo: "demo", tree, truncated: false } as Row;
    const cut = { id: "cd", shape: "gitDiff", role: "walk", repo: "demo", tree, truncated: true } as Row;
    for (const t of [[forged, verdict(["fd"])], [cut, verdict(["cd"])], [verdict([])]]) {
      table = t;
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no verdict approves this tree");
    }
    table = personOn(tree, "vq2");
    expect("pushed" in (await landClone(cwd, deps))).toBe(true);
  });

  scanned("[MUST-FAIL] on a gap, a grader's r 1 lands only when the gap's own check passed on the tree, for that gap", async () => {
    const { cwd, tree } = await change("q.txt", "q\n");
    const gap = { id: "gr1", shape: "gap", role: "detector", gap_id: "G1" } as Row;
    const diff = (check: unknown) => ({ id: "dg", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["gr1"], typecheck: TC_OK, suite: SUITE_OK, check } as Row);
    const v = { id: "vg", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["gr1", "dg"] } as Row;
    for (const check of [undefined, { gap_id: "G1", passed: false }, { gap_id: "G2", passed: true }]) {
      table = [gap, diff(check), v];
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no verdict approves this tree");
    }
    table = [gap, diff({ gap_id: "G1", passed: true }), v];
    expect("pushed" in (await landClone(cwd, deps))).toBe(true);
  });

  scanned("[MUST-FAIL] a grader's r 1 lands only from a diff whose whole suite turned no test red that passed on the base; the refusal names them", async () => {
    const { cwd, tree } = await change("s.txt", "s\n");
    const diff = (suite: unknown) => ({ id: "ds", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite } as Row);
    const v = { id: "vs", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "ds"] } as Row;
    const refusal = async (suite: unknown) => { table = [ask, diff(suite), v]; return String((await landClone(cwd, deps) as { error: string }).error); };
    // the engine case: the request's own test went green and another file's test, green on the base, went red
    const red = { ran: true, passed: false, exit_code: 1, out: "", truncated: false, regressed: ["lifecycle.test.ts > close > the failed task is recorded"] };
    expect(await refusal(red)).toContain("tests that passed on the base fail on it: lifecycle.test.ts > close > the failed task is recorded");
    // a suite that did not finish, or a diff that says nothing of it, lands nothing either, and says why
    expect(await refusal({ ran: false, passed: false, why: "the suite did not finish on the tree within the step bound (9 ms)" }))
      .toContain("the whole test suite did not say it passes: the suite did not finish on the tree within the step bound");
    expect(await refusal(undefined)).toContain("says nothing of the whole test suite");
    // many red: the first 20 named, the rest counted; exactly 20 are all named, with no count
    const many = (n: number) => ({ ...red, regressed: Array.from({ length: n }, (_, i) => `t.test.ts > t > case ${String(i).padStart(2, "0")}`) });
    const named = (msg: string) => msg.slice(msg.indexOf("fail on it: ") + 12).split("; ");
    const of25 = named(await refusal(many(25)));
    expect(of25).toEqual([...many(20).regressed, "and 5 more"]);
    expect(named(await refusal(many(20)))).toEqual(many(20).regressed);
    table = [ask, diff(SUITE_OK), v];
    expect("pushed" in (await landClone(cwd, deps))).toBe(true);
  });

  scanned("[MUST-FAIL] a grader's r 0 refuses the tree until a later grader's r 1 that meets every rule; it never waits on a person", async () => {
    const { cwd, tree } = await change("c.txt", "c\n");
    const diff = { id: "d2", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row;
    const no = { id: "v6", shape: "land_verdict", repo: "demo", tree, role: "described", r: 0, seq: 5, input_refs: ["ask1", "d2"] } as Row;
    const yes = (seq: number, refs = ["ask1", "d2"]) => ({ id: `v7-${seq}`, shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, seq, input_refs: refs }) as Row;
    // an older r 1, or one made at the same seq, does not lift the r 0
    for (const older of [3, 5]) {
      table = [ask, diff, yes(older), no];
      const refused = await landClone(cwd, deps) as { error: string; waits_for?: string };
      expect(String(refused.error)).toContain("a grader judged this tree r 0");
      expect(refused.waits_for).toBeUndefined(); // a grader's r 0 is a verdict on the change, not the gate waiting on a person
    }
    // a later r 1 lifts it only when it meets every rule a grader's r 1 meets: one on a diff whose suite turned a test red does not
    const red = { ...diff, id: "d2r", suite: { ...SUITE_OK, passed: false, regressed: ["t.test.ts > t > red"] } } as Row;
    table = [ask, diff, red, no, yes(7, ["ask1", "d2r"])];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    table = [ask, diff, no, yes(7)];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_ref).toBe("v7-7");
  });

  // A person's verdict on the walk's whole diff of a tree, and that diff. The USER's rule: a Wrong blocks that exact tree.
  const pv = (tree: string, id: string, r: number, seq: number, diff: Record<string, unknown> = {}): Row[] => [
    { id: `pd-${id}`, shape: "gitDiff", role: "walk", repo: "demo", tree, truncated: false, typecheck: TC_OK, suite: SUITE_OK, ...diff } as Row,
    { id, shape: "land_verdict", repo: "demo", tree, role: "person", r, seq, writer: "kid-person", input_refs: [`pd-${id}`] } as Row,
  ];
  const graderYes = (tree: string): Row[] => [
    { id: "gd", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row,
    { id: "gv", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, seq: 1, input_refs: ["ask1", "gd"] } as Row,
  ];

  scanned("[MUST-FAIL] a person's r 0 on the tree refuses it, though a grader's r 1 would land it", async () => {
    const { cwd, tree } = await change("p1.txt", "p1\n");
    table = [ask, ...graderYes(tree), ...pv(tree, "pv1", 0, 5)];
    expect(String((await landClone(cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
  });

  scanned("[MUST-FAIL] a person's latest mark on the tree decides: their Right after their Wrong lands it; Wrong after Right refuses", async () => {
    const a = await change("p2.txt", "p2\n");
    table = [ask, ...pv(a.tree, "pv2", 1, 5), ...pv(a.tree, "pv3", 0, 6)];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
    table = [ask, ...pv(a.tree, "pv2", 0, 5), ...pv(a.tree, "pv3", 1, 6)];
    const r = await landClone(a.cwd, deps);
    expect("pushed" in r && r.verdict_by).toBe("kid-person");
  });

  scanned("[MUST-FAIL] a grader's Right does not lift a person's Wrong; another person's later Right does", async () => {
    const a = await change("p2b.txt", "p2b\n");
    table = [ask, ...pv(a.tree, "pw", 0, 5), ...graderYes(a.tree)];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
    const other = pv(a.tree, "po", 1, 6); (other[1] as Row).writer = "kid-other-person";
    table = [ask, ...pv(a.tree, "pw", 0, 5), ...other];
    const r = await landClone(a.cwd, deps);
    expect("pushed" in r && r.verdict_by).toBe("kid-other-person");
  });

  scanned("[MUST-FAIL] latest is by records' seq, not by the order rows arrive in", async () => {
    const a = await change("p2e.txt", "p2e\n");
    // the Right (seq 9) arrives before the Wrong (seq 5): the Right is latest, it lands
    table = [ask, ...pv(a.tree, "pr4", 1, 9), ...pv(a.tree, "pw4", 0, 5)];
    expect("pushed" in await landClone(a.cwd, deps)).toBe(true);
    const b = await change("p2f.txt", "p2f\n");
    // the Wrong (seq 9) arrives before the Right (seq 5): the Wrong is latest, it refuses
    table = [ask, ...pv(b.tree, "pw5", 0, 9), ...pv(b.tree, "pr5", 1, 5)];
    expect(String((await landClone(b.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
  });

  scanned("[MUST-FAIL] a person's Right on another tree does not lift a Wrong on this one", async () => {
    const a = await change("p2d.txt", "p2d\n");
    table = [ask, ...pv(a.tree, "pw3", 0, 5), ...pv("T-elsewhere", "pr3", 1, 9)];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
  });

  scanned("[MUST-FAIL] a person's Right on a cut diff does not lift their Wrong (a Right counts only on what they saw whole)", async () => {
    const a = await change("p2c.txt", "p2c\n");
    table = [ask, ...pv(a.tree, "pw2", 0, 5), ...pv(a.tree, "pr2", 1, 6, { truncated: true })];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
  });

  scanned("[MUST-FAIL] a person's r 0 on this tree blocks it whatever diff it cites, cut or not; a person's r 1 on a cut diff counts for nothing", async () => {
    const a = await change("p3.txt", "p3\n");
    // a Wrong given on a cut diff: blocks, though a grader's r 1 would land it
    table = [ask, ...graderYes(a.tree), ...pv(a.tree, "pv4", 0, 5, { truncated: true })];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("a person judged this tree r 0");
    // a Right given on a cut diff is not approval of what the person saw: no person verdict, so nothing lands without one
    table = [ask, ...pv(a.tree, "pv5", 1, 6, { truncated: true })];
    expect(String((await landClone(a.cwd, deps) as { error?: string }).error)).toContain("no verdict approves this tree");
  });

  scanned("[MUST-FAIL] a person's Wrong on another tree, even the same change before a rebase, neither carries over nor blocks", async () => {
    const a = await change("p4.txt", "p4\n");
    // the person's r 0 on the tree this change had before it was remade: the new tree is judged on its own
    table = [ask, ...graderYes(a.tree), { ...pv("T-before", "pv7", 0, 5)[0] }, { ...pv("T-before", "pv7", 0, 5)[1], tree: "T-before" } as Row];
    expect("pushed" in await landClone(a.cwd, deps)).toBe(true);
  });

  scanned("[MUST-FAIL] a change to the gate's own files lands on a grader's r 1 like any other: no path waits on a person", async () => {
    const { cwd, tree } = await change("scripts/substrate/gate/x.sh", "x\n");
    const diff = { id: "d3", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row;
    table = [ask, diff, { id: "v9", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", "d3"] }];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_ref).toBe("v9");
    expect("needs_person" in r || "waits_for" in r).toBe(false);
  });

  scanned("[MUST-FAIL] an operator's ask is a request: a grader's r 1 on its diff lands the change on the same evidence", async () => {
    const { cwd, tree } = await change("op.txt", "op\n");
    const op = { id: "op1", shape: "world_changed", role: "operator" } as Row;
    const diff = { id: "d4", shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["op1"], typecheck: TC_OK, suite: SUITE_OK } as Row;
    // the same evidence: a red suite on its diff lands nothing for an operator's ask either
    table = [op, { ...diff, suite: { ...SUITE_OK, passed: false, regressed: ["t.test.ts > t > red"] } }, { id: "v10", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["op1", "d4"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    // a grade an operator wrote is not an ask
    const opGrade = { id: "op2", shape: "outcome", role: "operator" } as Row;
    table = [opGrade, { ...diff, input_refs: ["op2"] }, { id: "v11", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["op2", "d4"] }];
    expect("error" in (await landClone(cwd, deps))).toBe(true);
    table = [op, diff, { id: "v12", shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["op1", "d4"] }];
    const r = await landClone(cwd, deps);
    expect("pushed" in r && r.verdict_ref).toBe("v12");
  });

  scanned("[MUST-FAIL] a planted secret is refused by its rule, and the answer never carries its text", async () => {
    const secret = ["mb", "_", "Q".repeat(20), "z".repeat(20)].join("");
    const { cwd, tree } = await change("d.txt", `key = ${secret}\n`);
    table = personOn(tree, "v10");
    const r = await landClone(cwd, deps);
    expect(String((r as { error: string }).error)).toContain("secrets scan found");
    expect((r as unknown as { rules: string[] }).rules).toContain("substrate-api-key");
    expect(JSON.stringify(r)).not.toContain(secret);
  });

  scanned("[MUST-FAIL] a change that no longer fast-forwards origin, or holds a merge, is refused", async () => {
    const { cwd, tree } = await change("e.txt", "e\n");
    const elsewhere = join(T, "elsewhere");
    g(T, "clone", "-q", "-b", "dev", ORIGIN, elsewhere);
    writeFileSync(join(elsewhere, "z.txt"), "z\n"); commitAll(elsewhere, "moved on"); g(elsewhere, "push", "-q", "origin", "HEAD:dev");
    table = personOn(tree, "v11");
    expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("fast-forward");

    const m = await change("f.txt", "f\n");
    g(m.cwd, "checkout", "-q", "-b", "side", "HEAD~1");
    writeFileSync(join(m.cwd, "g.txt"), "g\n"); commitAll(m.cwd, "side");
    g(m.cwd, "checkout", "-q", "-");
    g(m.cwd, "merge", "-q", "--no-edit", "side");
    asOwner(m.cwd);
    table = personOn(g(m.cwd, "rev-parse", "HEAD^{tree}"), "v12");
    expect(String((await landClone(m.cwd, deps) as { error: string }).error)).toContain("merge");
  });

  it("[MUST-FAIL] with no secrets scanner on the node, nothing lands", async () => {
    const { cwd, tree } = await change("h.txt", "h\n");
    table = personOn(tree, "v13");
    const before = originHead();
    process.env.PATH = "/usr/bin:/bin";
    try {
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toContain("no secrets scanner");
    } finally { process.env.PATH = saved.PATH; }
    expect(originHead()).toBe(before);
  });

  scanned("[MUST-FAIL] a pre-push hook the clone sets up never runs: no hooks run beside the credential", async () => {
    const { cwd, tree } = await change("i.txt", "i\n");
    mkdirSync(join(cwd, "evil"));
    writeFileSync(join(cwd, "evil", "pre-push"), `#!/bin/sh\ntouch "${T}/PRE_PUSH_RAN"\n`, { mode: 0o755 });
    g(cwd, "config", "core.hooksPath", join(cwd, "evil"));
    asOwner(cwd);
    // and the node's own system hooks path (where the attempt ledger's hooks live) is not used beside the credential
    const sys = join(T, "gitconfig-system");
    writeFileSync(sys, `[core]\n\thooksPath = ${join(cwd, "evil")}\n`);
    const keep = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_SYSTEM = sys;
    table = personOn(tree, "v14");
    try {
      expect("pushed" in (await landClone(cwd, deps))).toBe(true);
    } finally { if (keep === undefined) delete process.env.GIT_CONFIG_SYSTEM; else process.env.GIT_CONFIG_SYSTEM = keep; }
    expect(await Bun.file(join(T, "PRE_PUSH_RAN")).exists()).toBe(false);
  });

  it("[MUST-FAIL] git_diff of a made clone answers the committed change with the tree it would land as", async () => {
    const { cwd, tree } = await change("j.txt", "j\n");
    g(cwd, "config", "diff.external", "/bin/false"); // the clone's config is never read
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.tree).toBe(tree);
    expect(r.base).toBe(originHead());
    expect(r.diff).toContain("+j");
    expect(r.truncated).toBe(false);
    expect(r.repo).toBe("demo");
    expect(r.typecheck).toEqual({ ran: false, passed: true, why: "the change touches no TypeScript file and the base has no root tsconfig.json: nothing to typecheck" });
  });

  it("[MUST-FAIL] a change of no TypeScript file to what chooses how it is checked does not pass the typecheck, on a base with no tsconfig.json", async () => {
    const { cwd } = await change("bunfig.toml", "[test]\n");
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.typecheck).toEqual({ ran: false, passed: false, why: "the change edits what chooses how it is checked: bunfig.toml" });
  });

  it("[MUST-FAIL] a git_diff says how long each of its steps took, once, by step name and milliseconds only", async () => {
    const { cwd } = await change("t.txt", "t\n");
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await diffClone(cwd, made.get(cwd)!, ["file"]);
      const lines = log.mock.calls.flat().map(String).filter((l) => l.startsWith("[git_diff] "));
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^\[git_diff\] status=\d+ms into_trusted=\d+ms diff=\d+ms write_out=\d+ms typecheck=\d+ms base_out=\d+ms suite=\d+ms total=\d+ms$/);
      expect(lines[0]).not.toContain(cwd); // no path
    } finally { log.mockRestore(); }
  });

  /** A clone with these files committed as one change (null deletes one); its cwd and tree. */
  const changeOf = async (files: Record<string, string | null>): Promise<{ cwd: string; tree: string }> => {
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w);
    for (const [f, text] of Object.entries(files)) {
      if (text === null) { rmSync(join(w.cwd, f)); continue; }
      mkdirSync(join(w.cwd, f, ".."), { recursive: true });
      writeFileSync(join(w.cwd, f), text);
    }
    asOwner(w.cwd);
    const c = await commitInClone(w.cwd, "change", undefined, find);
    if (!("tree" in c)) throw new Error(JSON.stringify(c));
    return { cwd: w.cwd, tree: c.tree };
  };
  const TSCONFIG = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"] }, include: ["*.ts"] });
  // From here on the base has a TypeScript config, as a vessel's does: a change is checked under it.
  const baseConfig = () => {
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "tsconfig.json"), TSCONFIG);
    commitAll(seed, "base config"); g(seed, "push", "-q", "origin", "HEAD:dev");
  };

  it("[MUST-FAIL] git_diff says whether the exact tree it names typechecks", async () => {
    baseConfig();
    const bad = await changeOf({ "m.ts": 'export const n: number = "not a number";\n' });
    const r = await diffClone(bad.cwd, made.get(bad.cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.tree).toBe(bad.tree);
    expect(r.typecheck).toMatchObject({ ran: true, passed: false });
    expect((r.typecheck as { out: string }).out).toContain("m.ts");
    expect((r.typecheck as { out: string }).out).not.toContain(T); // paths are the tree's own
    const good = await changeOf({ "m.ts": "export const n: number = 1;\n" });
    const ok = await diffClone(good.cwd, made.get(good.cwd)!, ["file"]);
    expect("tree" in ok && ok.typecheck).toMatchObject({ ran: true, passed: true, exit_code: 0 });
  });

  // The typecheck compiles every project a changed TypeScript file belongs to, on the base and on the change, and judges
  // the change by the errors it adds (research; d929's tree called an undefined function in ui/ while only the root ran).
  // Each test commits the base it needs (null removes a file), so it holds alone and in any order.
  const baseWith = (files: Record<string, string | null>) => {
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    for (const [f, text] of Object.entries(files)) {
      if (text === null) { rmSync(join(seed, f), { force: true }); continue; }
      mkdirSync(join(seed, f, ".."), { recursive: true });
      writeFileSync(join(seed, f), text);
    }
    if (Bun.spawnSync(["git", "-C", seed, "status", "--porcelain"]).stdout.toString().trim() === "") return; // already so
    commitAll(seed, "base for a typecheck test"); g(seed, "push", "-q", "origin", "HEAD:dev");
  };
  const ROOT_TS = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"] }, include: ["*.ts"] });
  const UI_TS = JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"], jsx: "preserve" }, include: ["src/**/*.ts", "src/**/*.tsx"] });
  const uiModules = (installed: boolean) => {
    const mods = join(T, "runtime", "demo", "ui", "node_modules");
    rmSync(mods, { recursive: true, force: true });
    if (!installed) return;
    mkdirSync(join(mods, "ui-only-pkg"), { recursive: true });
    writeFileSync(join(mods, "ui-only-pkg", "package.json"), JSON.stringify({ name: "ui-only-pkg", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(join(mods, "ui-only-pkg", "index.d.ts"), "export declare const one: number;\n");
  };
  const uiBase = (pkg: boolean) => baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "ui/tsconfig.json": UI_TS,
    "ui/package.json": pkg ? JSON.stringify({ name: "ui", dependencies: { "ui-only-pkg": "1.0.0" } }) : null,
    "ui/src/ok.tsx": pkg ? 'import { one } from "ui-only-pkg";\nexport const ok = one;\n' : "export const ok = 1;\n", "ui/src/old.ts": null });
  const check = async (files: Record<string, string | null>) => {
    const c = await changeOf(files);
    const r = await diffClone(c.cwd, made.get(c.cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    // every field a typecheck may carry, read without narrowing (a check that did not run has no passed)
    return r.typecheck as { ran: boolean; passed?: boolean; checked?: false; why?: string; exit_code?: number;
      projects?: Array<{ dir: string; passed: boolean; checked?: false; why?: string; base_errors?: number }>; uncovered?: string[]; out?: string };
  };

  it("[MUST-FAIL] an undefined call in a second project's file does not pass, named in that project; a correct one passes", async () => {
    uiBase(true); uiModules(true);
    const bad = await check({ "ui/src/Reports.tsx": 'export const h = parseHeadline("x");\n' });
    expect([bad.passed, bad.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [["ui", false]]]);
    expect(bad.out).toContain("parseHeadline");
    const good = await check({ "ui/src/Reports.tsx": 'import { one } from "ui-only-pkg";\nexport const h = one + 1;\n' });
    expect([good.passed, good.projects?.map((x) => [x.dir, x.passed])]).toEqual([true, [["ui", true]]]);
  });

  it("[MUST-FAIL] a project whose own packages are not installed on this node is not checked, and says so (qa)", async () => {
    uiBase(true); uiModules(false);
    const r = await check({ "ui/src/Reports.tsx": "export const h = 1;\n" });
    // its only project could not be compiled: the check did not run (agf_4x6rwwvu871p), never passed false
    expect([r.ran, r.checked, "passed" in r, r.projects] as unknown[]).toEqual([false, false, false, [{ dir: "ui", passed: false, exit_code: -1, checked: false, why: "ui's modules are not installed on this node: its project cannot be compiled here" }]]);
    // its files are that project's, not "covered by no project" (qa, deployment: a false fact on d929's row)
    expect([r.uncovered, r.why]).toEqual([undefined, "[ui] not checked: ui's modules are not installed on this node: its project cannot be compiled here"]);
    uiModules(true);
  });

  it("[MUST-FAIL] a project whose base cannot be compiled at all is not checked, never blamed on the change (research)", async () => {
    uiBase(false);
    baseWith({ "ui/tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: ["a-type-root-nobody-installed"], lib: ["es2022"] }, include: ["src/**/*.ts", "src/**/*.tsx"] }) });
    const r = await check({ "ui/src/Reports.tsx": "export const h = 1;\n" });
    expect([r.ran, "passed" in r]).toEqual([false, false]);
    expect(r.projects?.map((x) => [x.dir, x.checked])).toEqual([["ui", false]]);
    expect(String(r.projects?.[0]?.why)).toContain("the base does not compile here either");
  });

  it("[MUST-FAIL] one project checked beside one that cannot be: the check ran, and an unchecked project still keeps it from passing", async () => {
    uiBase(true); uiModules(false);
    const r = await check({ "ui/src/Reports.tsx": "export const h = 1;\n", "m.ts": "export const n: number = 1;\n" });
    expect([r.ran, r.passed, r.projects?.map((x) => [x.dir, x.checked ?? true]).sort()]).toEqual([true, false, [[".", true], ["ui", false]]]);
    const bad = await check({ "ui/src/Reports.tsx": "export const h = 1;\n", "m.ts": 'export const n: number = "wrong";\n' });
    expect([bad.ran, bad.passed]).toEqual([true, false]);
    uiModules(true);
  });

  it("[MUST-FAIL] an error the base already has is the base's: a change that adds none passes, one that adds one does not", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": 'export const b: number = "already wrong";\n' });
    const clean = await check({ "m.ts": "export const n: number = 1;\n" });
    expect([clean.passed, clean.projects?.map((x) => [x.dir, x.passed, x.base_errors])]).toEqual([true, [[".", true, 1]]]);
    const worse = await check({ "m.ts": 'export const n: number = "new wrong";\n' });
    expect([worse.passed, worse.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
    baseWith({ "base.ts": "export const b = 1;\n" });
  });

  it("[MUST-FAIL] a change in two projects runs both, and passes only if both do", async () => {
    uiBase(true); uiModules(true);
    const r = await check({ "m.ts": "export const n: number = 1;\n", "ui/src/two.ts": 'export const s: number = "x";\n' });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", true], ["ui", false]]]);
  });

  it("[MUST-FAIL] a TypeScript file no project of the base compiles is named, and only that keeps the tree from passing", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n" });
    const r = await check({ "tools/loose.ts": "export const x: number = 1;\n" });
    expect([r.passed, r.uncovered, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, ["tools/loose.ts"], [[".", true]]]);
  });

  it("[MUST-FAIL] a TypeScript file in a base with no TypeScript project at all does not pass", async () => {
    baseWith({ "tsconfig.json": null, "base.ts": null, "ui/tsconfig.json": null, "ui/package.json": null, "ui/src/ok.tsx": null });
    const r = await check({ "lone.ts": "export const x = 1;\n" });
    expect(r).toEqual({ ran: false, passed: false, why: "no TypeScript project of the base covers lone.ts" });
  });

  it("a change that only deletes a TypeScript file no project compiles has nothing to check", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "loose/gone.ts": "export const g = 1;\n" });
    const r = await check({ "loose/gone.ts": null, "notes.txt": "n\n" });
    expect(r.passed).toBe(true);
  });

  it("[MUST-FAIL] a change at the root is compiled by the root project", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n" });
    const r = await check({ "m.ts": 'export const n: number = "x";\n' });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
  });

  // qa's legs on a9276c89: each rule the comparison adds, pinned.
  it("[MUST-FAIL] a base error the change only moves (a line inserted above it) is still the base's", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": 'export const b: number = "already wrong";\n', "data.json": null });
    const r = await check({ "base.ts": 'export const z = 1;\nexport const b: number = "already wrong";\n' });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed, x.base_errors])]).toEqual([true, [[".", true, 1]]]);
  });

  it("[MUST-FAIL] a second copy of a base error is an error the change adds", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": 'export const b: number = "already wrong";\n', "data.json": null });
    const r = await check({ "base.ts": 'export const b: number = "already wrong";\nexport const c: number = "already wrong";\n' });
    expect(r.passed).toBe(false);
  });

  it("[MUST-FAIL] an error with no file location the base did not have is the change's", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "data.json": null });
    const r = await check({ "base.ts": null }); // the project's only source deleted: the compiler finds no inputs
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
  });

  it("[MUST-FAIL] a location-less error the change causes counts even when the base already fails (file not found)", async () => {
    // the base lists its files and already has an error in one, so the exit status cannot decide; deleting the other
    // makes the compiler say a listed file is missing, with no file location
    baseWith({ "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"] }, files: ["base.ts", "listed.ts"] }),
      "base.ts": 'export const b: number = "already wrong";\n', "listed.ts": "export const l = 1;\n", "data.json": null });
    const r = await check({ "listed.ts": null });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "listed.ts": null });
  });

  it("[MUST-FAIL] a compiler that fails only inside an installed package still fails the change that brought it in", async () => {
    uiBase(true); uiModules(true);
    const broken = join(T, "runtime", "demo", "ui", "node_modules", "broken-pkg");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "broken-pkg", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(join(broken, "index.d.ts"), "export declare const v: NoSuchType;\n");
    const r = await check({ "ui/src/uses-broken.ts": 'import { v } from "broken-pkg";\nexport const w = v;\n' });
    expect(r.passed).toBe(false);
  });

  it("[MUST-FAIL] a compiler ended by a signal does not pass, even when the base already has errors (qa)", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": 'export const b: number = "already wrong";\n', "data.json": null, "listed.ts": null });
    // a stand-in compiler where the gate finds the installed one: on the base it reports the base's error; on the
    // change it is killed by a signal before it says anything
    const mods = join(T, "runtime", "demo", "node_modules");
    const real = readlinkSync(mods);
    const fake = join(T, "fake-modules");
    mkdirSync(join(fake, "typescript", "bin"), { recursive: true });
    writeFileSync(join(fake, "typescript", "bin", "tsc"), [
      'const p = process.argv[process.argv.indexOf("-p") + 1] ?? "";',
      // the base's compile reads its source (listed as tsc lists it, absolute) and has the base's error
      'if (p.includes("base-typecheck")) { console.log(process.cwd() + "/base.ts"); console.log("base.ts(1,14): error TS2322: Type \'string\' is not assignable to type \'number\'."); process.exit(2); }',
      'process.kill(process.pid, "SIGKILL");',
    ].join("\n"));
    rmSync(mods);
    symlinkSync(fake, mods);
    try {
      const r = await check({ "m.ts": "export const n: number = 1;\n" });
      expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
    } finally { rmSync(mods); symlinkSync(real, mods); }
  });

  it("[MUST-FAIL] an error the change adds inside an installed package counts, even when the base already fails (deployment)", async () => {
    uiBase(true); uiModules(true);
    baseWith({ "ui/src/old.ts": 'export const o: number = "already wrong";\n' });
    const broken = join(T, "runtime", "demo", "ui", "node_modules", "broken-pkg");
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, "package.json"), JSON.stringify({ name: "broken-pkg", version: "1.0.0", types: "index.d.ts" }));
    writeFileSync(join(broken, "index.d.ts"), "export declare const v: NoSuchType;\n");
    const r = await check({ "ui/src/uses-broken.ts": 'import { v } from "broken-pkg";\nexport const w = v;\n' });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed, x.base_errors])]).toEqual([false, [["ui", false, 1]]]);
    baseWith({ "ui/src/old.ts": null });
  });

  it("[MUST-FAIL] a compiler that fails with no error line at all (a crash) does not pass on a clean base (qa, deployment)", async () => {
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "data.json": null, "listed.ts": null });
    const mods = join(T, "runtime", "demo", "node_modules");
    const real = readlinkSync(mods);
    const fake = join(T, "fake-crash-modules");
    mkdirSync(join(fake, "typescript", "bin"), { recursive: true });
    writeFileSync(join(fake, "typescript", "bin", "tsc"), [
      'const p = process.argv[process.argv.indexOf("-p") + 1] ?? "";',
      // the base compiles clean and lists its source; the change crashes with a stack trace and no error line
      'if (p.includes("base-typecheck")) { console.log(process.cwd() + "/base.ts"); process.exit(0); }',
      'console.log("RangeError: Maximum call stack size exceeded\\n    at checkSourceFile (tsc.js:1:1)"); process.exit(1);',
    ].join("\n"));
    rmSync(mods);
    symlinkSync(fake, mods);
    try {
      const r = await check({ "m.ts": "export const n: number = 1;\n" });
      expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
    } finally { rmSync(mods); symlinkSync(real, mods); }
  });

  it("[MUST-FAIL] a change that deletes a TypeScript file in a base with no project at all has nothing to check", async () => {
    baseWith({ "tsconfig.json": null, "base.ts": null, "ui/tsconfig.json": null, "ui/package.json": null, "ui/src/ok.tsx": null, "data.json": null, "gone2.ts": "export const g = 1;\n" });
    const r = await check({ "gone2.ts": null, "notes2.txt": "n\n" });
    expect(r).toEqual({ ran: false, passed: true, why: "the change only deletes TypeScript files no project of the base compiles: nothing to typecheck" });
  });

  it("[MUST-FAIL] packages the change carries in a project's node_modules are not what it is compiled against", async () => {
    uiBase(true); uiModules(true);
    const r = await check({
      "ui/node_modules/carried-pkg/index.ts": "export const c: number = 1;\n", // a .d.ts would be refused as silencing the check first
      "ui/src/uses-carried.ts": 'import { c } from "carried-pkg";\nexport const d = c;\n',
    });
    expect(r.passed).toBe(false);
    expect(r.out).toContain("carried-pkg");
  });

  it("[MUST-FAIL] a second project with no package.json of its own is compiled with the root's modules, not left unchecked", async () => {
    uiBase(false); uiModules(false);
    const r = await check({ "ui/src/fine.ts": "export const f: number = 1;\n" });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed, x.checked])]).toEqual([true, [["ui", true, undefined]]]);
    uiModules(true);
  });

  it("[MUST-FAIL] a change to no TypeScript file is still compiled by the root project (a data file a typed import reads)", async () => {
    baseWith({
      "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true, types: [], lib: ["es2022"], module: "esnext", moduleResolution: "bundler", resolveJsonModule: true, esModuleInterop: true }, include: ["*.ts"] }),
      "data.json": JSON.stringify({ n: 1 }), "base.ts": 'import data from "./data.json";\nexport const n: number = data.n;\n',
    });
    const r = await check({ "data.json": JSON.stringify({ n: "not a number" }) });
    expect([r.passed, r.projects?.map((x) => [x.dir, x.passed])]).toEqual([false, [[".", false]]]);
    baseWith({ "tsconfig.json": ROOT_TS, "base.ts": "export const b = 1;\n", "data.json": null });
  });

  it("[MUST-FAIL] a fix the clone has not committed does not make its tree pass", async () => {
    const { cwd } = await changeOf({ "m.ts": 'export const n: number = "x";\n' });
    writeFileSync(join(cwd, "m.ts"), "export const n: number = 1;\n"); // fixed in the clone, not in the tree that lands
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && r.typecheck).toMatchObject({ ran: true, passed: false });
    // [MUST-FAIL] and git_diff says so: the edit it does not show is named, so the walk can commit it
    expect("tree" in r && r.uncommitted).toEqual(["m.ts"]);
  });

  it("[MUST-FAIL] a diff of a clone holding an uncommitted path says uncommitted_any true", async () => {
    const { cwd } = await changeOf({ "m.ts": "export const n: number = 1;\n" });
    writeFileSync(join(cwd, "m.ts"), "export const n: number = 2;\n");
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && [r.uncommitted, r.uncommitted_any]).toEqual([["m.ts"], true]);
  });

  it("[MUST-FAIL] a diff of a clone holding nothing uncommitted says uncommitted_any false", async () => {
    const { cwd } = await changeOf({ "m.ts": "export const n: number = 1;\n" });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && [r.uncommitted, r.uncommitted_any]).toEqual([[], false]);
  });

  it("[GUARD] a clone whose status cannot be read says neither uncommitted nor uncommitted_any", async () => {
    const { cwd } = await changeOf({ "m.ts": "export const n: number = 1;\n" });
    const gone = join(OUT, "not-a-clone");
    mkdirSync(gone, { recursive: true });
    const r = await diffClone(gone, made.get(cwd)!, ["file"]);
    expect(["uncommitted" in r, "uncommitted_any" in r]).toEqual([false, false]);
  });

  it("[MUST-FAIL] a clone with no commit since it was made answers that, with what it holds uncommitted, not a bundle error", async () => {
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w);
    writeFileSync(join(w.cwd, "z.ts"), "export const z = 1;\n");
    mkdirSync(join(w.cwd, "sub"), { recursive: true });
    writeFileSync(join(w.cwd, "sub", "new.ts"), "export const y = 2;\n");
    asOwner(w.cwd);
    const r = await diffClone(w.cwd, w, ["file"]);
    expect("error" in r && r.error).toContain("no commit since it was made");
    expect("error" in r && r.error).not.toContain("could not be bundled");
    expect([...(r.uncommitted ?? [])].sort()).toEqual(["sub/new.ts", "z.ts"]);
  });

  it("[MUST-FAIL] the typecheck runs nothing of the clone's: not a compiler it carries, committed or not", async () => {
    const marker = join(OUT, "CLONE_TSC_RAN");
    const evil = `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`;
    const { cwd } = await changeOf({
      "m.ts": "export const n: number = 1;\n", "node_modules/typescript/bin/tsc": evil,
    });
    mkdirSync(join(cwd, "node_modules", "typescript", "bin"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "typescript", "bin", "tsc"), evil, { mode: 0o755 });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in r && r.typecheck).toMatchObject({ ran: true, passed: true });
    expect(existsSync(marker)).toBe(false);
  });

  it("[MUST-FAIL] a change cannot pass by deleting, loosening or silencing its own check: the base's config decides", async () => {
    const red = 'export const n: number = "x";\n';
    const cases: Array<Record<string, string | null>> = [
      { "m.ts": red, "tsconfig.json": null },
      { "m.ts": red, "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, types: [] }, include: [], files: [] }) },
      { "m.ts": "export const n: number = 1;\n", "package.json": "{}" },
      // or by silencing it in the source: a directive on a line it adds, or a declaration file it adds
      { "m.ts": `// @ts-nocheck\n${red}` },
      { "m.ts": `// @ts-ignore\n${red}` },
      { "m.ts": `// @ts-expect-error\n${red}` },
      { "m.ts": "import { q } from \"anything\";\nexport const n: number = q;\n", "anything.d.ts": "declare module \"anything\";\n" },
    ];
    for (const files of cases) {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
      expect("tree" in r && r.typecheck).toMatchObject({ passed: false });
    }
  });

  it("[MUST-FAIL] git_diff runs the gap's own check on the exact tree: it passes only when the source is fixed", async () => {
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "calc.ts"), "export const add = (a: number, b: number): number => a - b;\n");
    writeFileSync(join(seed, "calc.test.ts"), 'import { expect, test, describe } from "bun:test";\nimport { add } from "./calc";\n' +
      'describe("add", () => { test("adds", () => { expect(add(1, 2)).toBe(3); }); test("zero", () => { expect(add(0, 0)).toBe(0); }); });\n');
    commitAll(seed, "a failing check"); g(seed, "push", "-q", "origin", "HEAD:dev");
    const gap = { gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] };
    const check = async (files: Record<string, string | null>, g2: unknown = gap) => {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"], g2 as never);
      if (!("tree" in r)) throw new Error(JSON.stringify(r));
      return r.check;
    };
    const fixed = "export const add = (a: number, b: number): number => a + b;\n";
    expect(await check({ "calc.ts": fixed })).toMatchObject({ gap_id: "G1", test_file: "calc.test.ts", ran: true, passed: true });
    // a gap's diff also says how long writing out the base and running the gap's check took (the steps suspected of overrunning)
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await check({ "calc.ts": fixed });
      const line = log.mock.calls.flat().map(String).find((l) => l.startsWith("[git_diff] "));
      expect(line).toMatch(/ typecheck=\d+ms base_out=\d+ms gap_check=\d+ms suite=\d+ms total=\d+ms$/);
    } finally { log.mockRestore(); }
    expect(await check({ "calc.ts": "export const add = (a: number, b: number): number => a * b;\n" })).toMatchObject({ ran: true, passed: false });
    // the check is the base's: a change to the test, or to what tests lean on, does not pass whatever it does
    expect(await check({ "calc.test.ts": 'import { test } from "bun:test";\ntest("adds", () => {});\n' })).toMatchObject({ passed: false });
    expect(await check({ "calc.ts": fixed, "fixtures/x.json": "{}" })).toMatchObject({ passed: false });
    // the tested code shares the runner's process: a source that prints the runner's pass lines and exits does not pass,
    // whether the change says so plainly or builds the words at run time (then the runner writes no report)
    const forge = 'console.log("(pass) add > adds\\n 1 pass\\n 0 fail");\nprocess.exit(0);\n' + fixed;
    expect(await check({ "calc.ts": forge })).toMatchObject({ passed: false, why: expect.stringContaining("writes what the check reads") });
    const hidden = 'const p = (globalThis as any)["pro" + "cess"];\nconsole.log("(pa" + "ss) add > adds\\n 1 pa" + "ss");\np["ex" + "it"](0);\n' + fixed;
    expect(await check({ "calc.ts": hidden })).toMatchObject({ ran: true, passed: false });
    // fails closed: a test file not in the tree, or a gap that could not be read
    expect(await check({ "calc.ts": fixed }, { ...gap, test_file: "nope.test.ts" })).toMatchObject({ passed: false });
    expect(await check({ "calc.ts": fixed }, { error: "unreadable" })).toEqual({ ran: false, passed: false, why: "unreadable" });
    // not made for a gap: no check at all
    const { cwd } = await changeOf({ "calc.ts": fixed });
    const plain = await diffClone(cwd, made.get(cwd)!, ["file"]);
    expect("tree" in plain && "check" in plain).toBe(false);
  });

  it("[MUST-FAIL] a gap's check is judged against the base: a fix that turns a passing test red does not pass, and a gap whose test already passes there is not checked", async () => {
    // the base from the case above: add subtracts, so "add > adds" fails there and "add > zero" passes
    const gap = { gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] };
    const check = async (files: Record<string, string | null>, g2: unknown = gap) => {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"], g2 as never);
      if (!("tree" in r)) throw new Error(JSON.stringify(r));
      return r.check;
    };
    const fixed = "export const add = (a: number, b: number): number => a + b;\n";
    expect(await check({ "calc.ts": fixed })).toMatchObject({ ran: true, passed: true, regressed: [] });
    // the named test turns green and a test that passed on the base turns red: it does not pass, and says which
    const breaks = "export const add = (a: number, b: number): number => (a === 0 && b === 0 ? 1 : a + b);\n";
    expect(await check({ "calc.ts": breaks })).toMatchObject({ ran: true, passed: false, regressed: ["add > zero"] });
    // a gap whose named test already passes on the base: nothing for the check to tell
    expect(await check({ "calc.ts": fixed }, { ...gap, only_tests: ["add > zero"] }))
      .toEqual({ gap_id: "G1", test_file: "calc.test.ts", ran: false, passed: false, why: "the gap's test already passes on the base" });
    // the base's result is read before anything of the change runs: a change that rewrites the base's report, as if
    // nothing had passed there, still has its red test counted
    const forge = 'import { writeFileSync } from "node:fs";\ntry { writeFileSync("../base-report/" + "jun" + "it.xml", "<testsuites></testsuites>"); } catch {}\n' + breaks;
    expect(await check({ "calc.ts": forge })).toMatchObject({ ran: true, passed: false, regressed: ["add > zero"] });
  });

  it("[MUST-FAIL] git_diff runs the whole suite on the base and the tree: a test green on the base and red on the tree is named, one red on both is not", async () => {
    // the base from the cases above: add subtracts, so "add > adds" fails there and "add > zero" passes. A second file
    // pins what any fix must keep, as a lifecycle test pins what the source does on purpose.
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "life.test.ts"), 'import { expect, test, describe } from "bun:test";\nimport { add } from "./calc";\n' +
      'describe("life", () => { test("adding zero keeps the number", () => { expect(add(5, 0)).toBe(5); }); });\n');
    commitAll(seed, "a second test file"); g(seed, "push", "-q", "origin", "HEAD:dev");
    const gap = { gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] };
    const diffOf = async (files: Record<string, string | null>, g2: unknown = null) => {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"], g2 as never);
      if (!("tree" in r)) throw new Error(JSON.stringify(r));
      return r;
    };
    // the gap's own test goes green, and the other file's, green on the base, goes red: the gap's check, which runs its
    // file alone, passes; the whole suite does not, and names the test with its file
    const breaks = "export const add = (a: number, b: number): number => (b === 0 ? 0 : a + b);\n";
    const broke = await diffOf({ "calc.ts": breaks }, gap);
    expect(broke.check).toMatchObject({ ran: true, passed: true });
    expect(broke.suite).toMatchObject({ ran: true, passed: false });
    expect((broke.suite as { regressed: string[] }).regressed).toEqual([expect.stringMatching(/life\.test\.ts > life > adding zero keeps the number$/)]);
    // [MUST-FAIL] its out leads with that test's own assertion, from the tree's report, and the row says what judged the
    // tree before the diff, so a reader keeping the row's start keeps why it did not pass
    expect((broke.suite as { out: string }).out).toMatch(/^\(fail\) \S*life\.test\.ts > life > adding zero keeps the number\n[^]*Expected: 5\nReceived: 0/);
    const keys = Object.keys(broke);
    expect(keys.indexOf("suite")).toBeLessThan(keys.indexOf("diff"));
    expect(keys.indexOf("typecheck")).toBeLessThan(keys.indexOf("diff"));
    expect(keys.indexOf("check")).toBeLessThan(keys.indexOf("diff"));
    // the fix that keeps it: passes, though "add > adds" was red on the base
    expect((await diffOf({ "calc.ts": "export const add = (a: number, b: number): number => a + b;\n" }, gap)).suite).toMatchObject({ ran: true, passed: true, regressed: [] });
    // a change for no gap that leaves "add > adds" red as the base has it: that test is the base's, not the change's
    expect((await diffOf({ "notes.txt": "n\n" })).suite).toMatchObject({ ran: true, passed: true, regressed: [] });
    // a test the change removes no longer passes on the tree
    expect((await diffOf({ "life.test.ts": null })).suite).toMatchObject({ ran: true, passed: false,
      regressed: [expect.stringMatching(/life\.test\.ts > life > adding zero keeps the number$/)] });
  });

  it("[MUST-FAIL] a gap the whole suite found is checked by the whole suite: its named tests green, and nothing that passed on the base red", async () => {
    // the base from the cases above: add subtracts, so "add > adds" fails there; "add > zero" and life's test pass. The
    // gap names no file, as the gate's regression gap does: its named tests are anywhere in the suite, by their leaf
    // its vessel as pull-sync writes it: the name of the vessel's copy under the clones root, which makeWorktree("demo")
    // above cloned from, so made.repo is the same string
    const gap = { gap_id: "R1", vessel: "demo", only_tests: ["add > adds"] };
    const checkOf = async (files: Record<string, string | null>, g2: unknown = gap) => {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"], g2 as never);
      if (!("tree" in r)) throw new Error(JSON.stringify(r));
      return r;
    };
    const fixed = "export const add = (a: number, b: number): number => a + b;\n";
    // named green, nothing new red: it passes, and the suite says the same of the same runs
    const ok = await checkOf({ "calc.ts": fixed });
    expect(ok.check).toEqual(expect.objectContaining({ gap_id: "R1", ran: true, passed: true, regressed: [] }));
    expect("test_file" in (ok.check as object)).toBe(false);
    expect(ok.suite).toMatchObject({ ran: true, passed: true });
    // named still red: it does not pass
    expect((await checkOf({ "notes.txt": "n\n" })).check).toMatchObject({ ran: true, passed: false });
    // [MUST-FAIL] a suite of another vessel says nothing of this clone's: not run, and the why names both
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, vessel: "other-vessel" })).check)
      .toEqual({ gap_id: "R1", ran: false, passed: false, why: "the gap's suite is other-vessel's, and this clone is of demo" });
    // some named test red on the base is enough to check: of "add > adds" (red there) and "add > zero" (green there), the
    // fix passes
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, only_tests: ["add > adds", "add > zero"] })).check).toMatchObject({ ran: true, passed: true });
    // every named test, not some: of two, one the tree still does not pass, it does not pass
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, only_tests: ["add > adds", "add > absent"] })).check).toMatchObject({ ran: true, passed: false });
    // named green by breaking a test that passed on the base: it does not pass, and names that test
    const breaks = "export const add = (a: number, b: number): number => (b === 0 ? 0 : a + b);\n";
    expect((await checkOf({ "calc.ts": breaks })).check).toMatchObject({ ran: true, passed: false,
      regressed: [expect.stringMatching(/life\.test\.ts > life > adding zero keeps the number$/)] });
    // [MUST-FAIL] a name written whole, its file included (as a person may file it), is that test: green on the base,
    // so there is nothing for the check to tell
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, only_tests: ["life.test.ts > life > adding zero keeps the number"] })).check)
      .toEqual({ gap_id: "R1", ran: false, passed: false, why: "the gap's tests already pass on the base" });
    // a gap whose named tests already pass on the base: nothing for the check to tell
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, only_tests: ["add > zero"] })).check)
      .toEqual({ gap_id: "R1", ran: false, passed: false, why: "the gap's tests already pass on the base" });
    // no names: the suite's exit, red on the base and green on the tree
    expect((await checkOf({ "calc.ts": fixed }, { ...gap, only_tests: [] })).check).toMatchObject({ ran: true, passed: true });
    expect((await checkOf({ "notes.txt": "n\n" }, { ...gap, only_tests: [] })).check).toMatchObject({ ran: true, passed: false });
    // the check is the base's: a change to a test does not pass, whatever it does
    expect((await checkOf({ "calc.ts": fixed, "life.test.ts": null })).check)
      .toMatchObject({ passed: false, why: "the change edits the check: life.test.ts" });
    // no names and a base whose whole suite is green: nothing for the check to tell. The base is put back after, as the
    // cases below read it.
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "calc.ts"), fixed);
    commitAll(seed, "a green base"); g(seed, "push", "-q", "origin", "HEAD:dev");
    try {
      expect((await checkOf({ "notes.txt": "n\n" }, { ...gap, only_tests: [] })).check)
        .toEqual({ gap_id: "R1", ran: false, passed: false, why: "the gap's tests already pass on the base" });
    } finally {
      writeFileSync(join(seed, "calc.ts"), "export const add = (a: number, b: number): number => a - b;\n");
      commitAll(seed, "the base as it was"); g(seed, "push", "-q", "origin", "HEAD:dev");
    }
    // a name two files share: green on a side only when every test it matches there is. Here another file's "add >
    // adds" stays red, so the fix of calc's does not pass (and a gap so named cannot land while that test is red)
    writeFileSync(join(seed, "dup.test.ts"), 'import { expect, test, describe } from "bun:test";\n' +
      'describe("add", () => { test("adds", () => { expect(1).toBe(2); }); });\n');
    commitAll(seed, "a second adds"); g(seed, "push", "-q", "origin", "HEAD:dev");
    try {
      expect((await checkOf({ "calc.ts": fixed })).check).toMatchObject({ ran: true, passed: false, regressed: [] });
    } finally {
      rmSync(join(seed, "dup.test.ts"));
      commitAll(seed, "one adds again"); g(seed, "push", "-q", "origin", "HEAD:dev");
    }
    // a name matches whole describes only: "padd > adds", red on both sides, ends with the named "add > adds" as text but
    // is another test, so the fix of calc's still passes
    writeFileSync(join(seed, "pad.test.ts"), 'import { expect, test, describe } from "bun:test";\n' +
      'describe("padd", () => { test("adds", () => { expect(1).toBe(2); }); });\n');
    commitAll(seed, "a padd > adds"); g(seed, "push", "-q", "origin", "HEAD:dev");
    try {
      expect((await checkOf({ "calc.ts": fixed })).check).toMatchObject({ ran: true, passed: true, regressed: [] });
    } finally {
      rmSync(join(seed, "pad.test.ts"));
      commitAll(seed, "no padd"); g(seed, "push", "-q", "origin", "HEAD:dev");
    }
  });

  it("[MUST-FAIL] a change of no gap cannot write the suite's report or choose how the suite runs: a test, a preload, or bunfig alone", async () => {
    // the base from the cases above, with a preload the base's bunfig names
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "bunfig.toml"), '[test]\npreload = ["./setup.ts"]\n');
    writeFileSync(join(seed, "setup.ts"), "export {};\n");
    commitAll(seed, "a preload"); g(seed, "push", "-q", "origin", "HEAD:dev");
    const suiteOf = async (files: Record<string, string | null>) => {
      const { cwd } = await changeOf(files);
      const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
      if (!("tree" in r)) throw new Error(JSON.stringify(r));
      return r.suite;
    };
    const fake = '<testsuites><testsuite name="life.test.ts"><testsuite name="life"><testcase name="adding zero keeps the number" /></testsuite></testsuite></testsuites>';
    const breaks = "export const add = (a: number, b: number): number => (b === 0 ? 0 : a + b);\n";
    // a test the change adds writes the report the suite is read from, as if every test passed, and ends the run
    const writer = `import { writeFileSync } from "node:fs";\nimport { test } from "bun:test";\nwriteFileSync("../check-suite-report/junit.xml", ${JSON.stringify(fake)});\nprocess.exit(0);\ntest("x", () => {});\n`;
    expect(await suiteOf({ "calc.ts": breaks, "zz.test.ts": writer })).toMatchObject({ ran: false, passed: false, why: expect.stringContaining("writes what the suite's report is read from") });
    // the preload the base's bunfig names does it
    expect(await suiteOf({ "calc.ts": breaks, "setup.ts": writer.replace('import { test } from "bun:test";\n', "").replace('test("x", () => {});\n', "") }))
      .toMatchObject({ ran: false, passed: false, why: expect.stringContaining("writes what the suite's report is read from") });
    // bunfig alone: a change to it chooses how the suite runs (here, which tests it finds), and the typecheck refuses it too
    const { cwd } = await changeOf({ "calc.ts": breaks, "bunfig.toml": '[test]\nroot = "./none"\n' });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.suite).toMatchObject({ ran: false, passed: false, why: "the change edits what chooses how the suite runs: bunfig.toml" });
    expect(r.typecheck).toMatchObject({ passed: false, why: "the change edits what chooses how it is checked: bunfig.toml" });
    // and a change that is none of these still has its suite run
    expect(await suiteOf({ "calc.ts": breaks })).toMatchObject({ ran: true, passed: false });
  });

  it("[GUARD] the suite's guard reads only the lines a change adds, and a change it cannot read is refused", async () => {
    // a change that only removes a line the pattern matches adds nothing that could write the report
    const seed = join(T, "seed");
    writeFileSync(join(seed, "ender.ts"), "export const end = (): never => process.exit(1);\nexport const kept = 1;\n");
    commitAll(seed, "an ender"); g(seed, "push", "-q", "origin", "HEAD:dev");
    const { cwd } = await changeOf({ "ender.ts": "export const kept = 1;\n" });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"]);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.suite).toMatchObject({ ran: true });
    // nor does a file whose name alone the pattern matches: its diff header is not a line the change adds
    const { cwd: named } = await changeOf({ "junit-notes.txt": "plain\n" });
    const n = await diffClone(named, made.get(named)!, ["file"]);
    if (!("tree" in n)) throw new Error(JSON.stringify(n));
    expect(n.suite).toMatchObject({ ran: true });
    // a read that fails refuses: the paths, then the lines
    const reads = (fail: "name-only" | "-U0") => ({ repo: "demo", origin: "o", head: "h", tree: "t",
      out: async (args: string[]) => (args.includes(`--${fail}`) || args.includes(fail) ? null : ""),
      step: async () => ({ error: "unused" }) }) as unknown as Trusted;
    expect(await suiteRefuses(reads("name-only"))).toBe("the change's paths could not be read");
    expect(await suiteRefuses(reads("-U0"))).toBe("the change's lines could not be read");
    expect(await suiteRefuses({ ...reads("-U0"), out: async () => "" } as unknown as Trusted)).toBeNull();
  });

  it("[MUST-FAIL] a whole suite that does not finish within the bound does not pass, and says on which side", async () => {
    const dirOf = (name: string, body: string) => {
      const d = mkdtempSync(join(tmpdir(), `suite-${name}-`));
      chmodSync(d, 0o755);
      writeFileSync(join(d, "x.test.ts"), `import { test } from "bun:test";\n${body}\n`, { mode: 0o644 });
      return d;
    };
    const ok = dirOf("ok", 'test("ok", () => {});');
    const hangs = dirOf("hang", 'test("waits", async () => { await new Promise(() => {}); }, 600000);');
    expect(await suiteCheck(hangs, ok, 4000)).toEqual({ ran: false, passed: false, why: "the suite did not finish on the tree within the step bound (4000 ms)" });
    expect(await suiteCheck(ok, hangs, 4000)).toEqual({ ran: false, passed: false, why: "the suite did not finish on the base within the step bound (4000 ms)" });
    // a run that exits before the runner reports leaves no report: it does not pass, and says on which side
    const exits = dirOf("exit", 'process.exit(0);\ntest("never", () => {});');
    expect(await suiteCheck(exits, ok, 60000)).toEqual({ ran: false, passed: false, why: "the suite's run on the tree wrote no report" });
    expect(await suiteCheck(ok, exits, 60000)).toEqual({ ran: false, passed: false, why: "the suite's run on the base wrote no report" });
    expect(await suiteCheck(ok, ok, 60000)).toMatchObject({ ran: true, passed: true, regressed: [] });
  }, 120000);

  it("[MUST-FAIL] a gap's check that fails and then prints past the bound still shows how it failed", async () => {
    // the base from the cases above: add subtracts, so "add > adds" fails there. This change still fails it, then prints
    // much on the runner's own stream while "add > zero" runs, so a plain cut of the run's end would keep only that.
    const gap = { gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] };
    const noisy = 'const noise = Array.from({ length: 80 }, (_, i) => "noise line " + i + " " + "x".repeat(60)).join("\\n");\n' +
      "export const add = (a: number, b: number): number => { if (a === 0) console.error(noise); return a - b; };\n";
    const { cwd } = await changeOf({ "calc.ts": noisy });
    const r = await diffClone(cwd, made.get(cwd)!, ["file"], gap as never);
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.check).toMatchObject({ ran: true, passed: false, truncated: true });
    const out = String((r.check as { out?: unknown }).out);
    expect(out).toContain("noise line 79"); // the end is kept too
    expect(out).toContain("Expected: 3"); // and the failing test's own words
  });

  it("[MUST-FAIL] a test passed only when the runner's report has it with no failure, error or skip", () => {
    const xml = '<?xml version="1.0"?><testsuites name="bun test" tests="4"><testsuite name="calc.test.ts" file="calc.test.ts">' +
      '<testcase name="top" classname="" /><testsuite name="add &amp; sub"><testcase name="adds" classname="add" />' +
      '<testcase name="bad" classname="add"><failure type="AssertionError" /></testcase>' +
      '<testcase name="later" classname="add"><skipped /></testcase></testsuite></testsuite></testsuites>';
    expect([...passedIn(xml)].sort()).toEqual(["add & sub > adds", "top"]);
    // several files run at once: each name starts at its file, so tests of the same name in two files stay apart
    expect([...passedIn(xml, true)].sort()).toEqual(["calc.test.ts > add & sub > adds", "calc.test.ts > top"]);
    expect(passedIn("").size).toBe(0);
  });

  it("[MUST-FAIL] the gap a diff is checked for is the one its call's selection was made on", async () => {
    const rowsOf = (all: Row[]) => async (q: Query) => all.filter((r) => q.ids?.includes(r.id));
    const gapRow = { id: "gr", shape: "gap", role: "detector", gap_id: "G1",
      meta: { evidence_resolve: { input: { test_file: "calc.test.ts", only_tests: ["add > adds"] } } } } as Row;
    const sel = (root: string) => ({ id: "s1", shape: "selection", role: "walk", root } as Row);
    expect(await gapOf(rowsOf([sel("gr"), gapRow]), "s1")).toEqual({ gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] });
    expect(await gapOf(rowsOf([sel("ask1"), ask]), "s1")).toBeNull();
    expect(await gapOf(rowsOf([]), undefined)).toBeNull();
    expect(await gapOf(rowsOf([sel("gr"), { ...gapRow, meta: {} } as Row]), "s1")).toMatchObject({ error: expect.stringContaining("no test file") });
    expect(await gapOf(rowsOf([{ id: "s1", shape: "selection" } as Row]), "s1")).toMatchObject({ error: expect.stringContaining("no root") });
    // [MUST-FAIL] a test_suite of its vessel naming no file: the check is the whole suite, its named tests anywhere in it
    const suiteRow = { ...gapRow, gap_id: "R1", meta: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/demo", only_tests: ["add > adds"] } } } } as Row;
    expect(await gapOf(rowsOf([sel("gr"), suiteRow]), "s1")).toEqual({ gap_id: "R1", vessel: "demo", only_tests: ["add > adds"] });
    // the vessel as pull-sync writes it (its name, no prefix) is the same vessel
    const bare = { ...suiteRow, meta: { evidence_resolve: { shape: "test_suite", input: { vessel: "demo", only_tests: ["add > adds"] } } } } as Row;
    expect(await gapOf(rowsOf([sel("gr"), bare]), "s1")).toEqual({ gap_id: "R1", vessel: "demo", only_tests: ["add > adds"] });
    // [MUST-FAIL] the evidence exactly as pull-sync's regression_evidence writes it for a vessel: its vessel is the name
    // of the vessel's copy under the clones root, the repo git_worktree clones that vessel as (makeWorktree's made.repo)
    const emitted = JSON.parse('{"shape":"test_suite","input":{"vessel":"local-tools-vessel","only_tests":["add > adds"]}}');
    expect(await gapOf(rowsOf([sel("gr"), { ...suiteRow, meta: { evidence_resolve: emitted } } as Row]), "s1"))
      .toEqual({ gap_id: "R1", vessel: "local-tools-vessel", only_tests: ["add > adds"] });
    // a test_suite naming its file is that file's check, as before
    const fileRow = { ...gapRow, meta: { evidence_resolve: { shape: "test_suite", input: { vessel: "repos/demo", test_file: "calc.test.ts", only_tests: ["add > adds"] } } } } as Row;
    expect(await gapOf(rowsOf([sel("gr"), fileRow]), "s1")).toEqual({ gap_id: "G1", test_file: "calc.test.ts", only_tests: ["add > adds"] });
    // [GUARD] a row that does not say its check stays an error: the gate's regression row as it is written today (no
    // evidence_resolve), a suite naming no vessel, and an input with no shape
    const regression = { ...gapRow, gap_id: "R0", meta: { vessel: "demo", head: "h", refusals: 2, regression: "1 test(s) newly failing" } } as Row;
    expect(await gapOf(rowsOf([sel("gr"), regression]), "s1")).toMatchObject({ error: "gap R0 names no test file" });
    for (const evidence_resolve of [{ shape: "test_suite", input: { only_tests: ["a"] } }, { input: { vessel: "repos/demo", only_tests: ["a"] } },
      { shape: "test_suite", input: { vessel: "", only_tests: ["a"] } }, { shape: "other", input: { vessel: "repos/demo" } }])
      expect(await gapOf(rowsOf([sel("gr"), { ...gapRow, meta: { evidence_resolve } } as Row]), "s1")).toMatchObject({ error: expect.stringContaining("no test file") });
  });

  it("[MUST-FAIL] a clone origin has moved past shows its own change, says it cannot fast-forward, and does not pass", async () => {
    const { cwd } = await changeOf({ "own.txt": "mine\n" });
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    writeFileSync(join(seed, "later.txt"), "pushed after the clone\n");
    commitAll(seed, "origin moves on"); g(seed, "push", "-q", "origin", "HEAD:dev");
    const r = await diffClone(cwd, made.get(cwd)!, ["file"], { gap_id: "G1", test_file: "calc.test.ts", only_tests: [] });
    if (!("tree" in r)) throw new Error(JSON.stringify(r));
    expect(r.fast_forward).toBe(false);
    expect(r.diff).toContain("+mine");
    expect(r.diff).not.toContain("later.txt"); // origin's later commit is not shown undone
    expect(r.typecheck).toMatchObject({ passed: false, why: expect.stringContaining("ask for a fresh clone") });
    expect(r.check).toMatchObject({ passed: false, why: expect.stringContaining("ask for a fresh clone") });
    expect(r.suite).toMatchObject({ passed: false, why: expect.stringContaining("ask for a fresh clone") });
    const fresh = await changeOf({ "own2.txt": "mine\n" });
    const ok = await diffClone(fresh.cwd, made.get(fresh.cwd)!, ["file"]);
    expect("tree" in ok && ok.fast_forward).toBe(true);
  });
});

describe("git_land: the USER's protected list", () => {
  const graderOn = (tree: string, id: string): Row[] => [ask,
    { id: `gd-${id}`, shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row,
    { id, shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", `gd-${id}`] } as Row];

  scanned("[MUST-FAIL] a path the list names is out of the walk's reach: never committed, and slipped in by hand it lands on no verdict, a person's r 1 included", async () => {
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w); asOwner(w.cwd);
    mkdirSync(join(w.cwd, "protected"), { recursive: true });
    writeFileSync(join(w.cwd, "protected", "x.ts"), "export const x = 1\n");
    const c = await commitInClone(w.cwd, "x", undefined, find) as { error?: string; out_of_reach?: string[] };
    expect(String(c.error)).toContain("outside the walk's reach");
    expect(c.out_of_reach).toEqual(["protected/x.ts (protected: repos/demo/protected/)"]);
    commitAll(w.cwd, "slipped in by hand");
    const tree = g(w.cwd, "rev-parse", "HEAD^{tree}");
    for (const rows of [personOn(tree, "pp1"), graderOn(tree, "pg1")]) {
      table = rows;
      const r = await landClone(w.cwd, deps) as { error?: string; out_of_reach?: string[]; waits_for?: string };
      expect(String(r.error)).toContain("outside the walk's reach");
      expect(r.out_of_reach).toEqual(["protected/x.ts (protected: repos/demo/protected/)"]);
      expect(r.waits_for).toBeUndefined();
    }
  });

  scanned("a path only like a listed directory's name is not in it, and lands on a grader's r 1", async () => {
    const { cwd, tree } = await change("protected-x/y.ts", "y\n");
    table = graderOn(tree, "pg2");
    expect("pushed" in (await landClone(cwd, deps))).toBe(true);
  });

  scanned("[MUST-FAIL] a rename out of a listed directory counts the name it leaves", async () => {
    // protected/x.ts on origin, put there as the owner would (nothing the walk makes lands it)
    const seed = join(T, "seed");
    g(seed, "pull", "-q", "origin", "dev");
    mkdirSync(join(seed, "protected"), { recursive: true });
    writeFileSync(join(seed, "protected", "x.ts"), "export const x = 1\n");
    commitAll(seed, "a protected file"); g(seed, "push", "-q", "origin", "HEAD:dev");
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w); asOwner(w.cwd);
    g(w.cwd, "mv", "protected/x.ts", "moved-x.ts");
    const c = await commitInClone(w.cwd, "move out", undefined, find) as { error?: string; out_of_reach?: string[] };
    expect(c.out_of_reach).toContain("protected/x.ts (protected: repos/demo/protected/)");
    commitAll(w.cwd, "move out by hand");
    table = graderOn(g(w.cwd, "rev-parse", "HEAD^{tree}"), "pg3");
    const r = await landClone(w.cwd, deps) as { error?: string; out_of_reach?: string[] };
    expect(String(r.error)).toContain("outside the walk's reach");
    expect(r.out_of_reach).toContain("protected/x.ts (protected: repos/demo/protected/)");
  });

  it("[MUST-FAIL] a super base with no readable list refuses the commit, never reads as no hits", async () => {
    const good = g(SUPER, "rev-parse", "HEAD");
    writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), "{ not json\n");
    commitAll(SUPER, "unreadable list");
    try {
      g(COPY, "pull", "-q", "origin", "dev");
      const w = await makeWorktree("demo");
      if ("error" in w) throw new Error(w.error);
      made.set(w.cwd, w); asOwner(w.cwd);
      writeFileSync(join(w.cwd, "free.txt"), "f\n");
      const c = await commitInClone(w.cwd, "free", undefined, find);
      expect(String((c as { error: string }).error)).toContain("protected list");
    } finally {
      writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), SCOPE(["scripts/substrate/", ".claude/", "repos/demo/protected/"]));
      commitAll(SUPER, "list restored");
      expect(g(SUPER, "rev-parse", "HEAD")).not.toBe(good);
    }
  });

  it("[MUST-FAIL] git_land reads a super-repo change's list at origin, and a vessel's as the current list: never the change, never the clone's base", async () => {
    const { listSourceFor } = await import("./git-land");
    expect(listSourceFor({ repo: "super" }, "refs/remotes/origin/dev")).toEqual({ in: "trusted", ref: "refs/remotes/origin/dev", where: "origin" });
    expect(listSourceFor({ repo: "demo" }, "refs/remotes/origin/dev")).toEqual({ in: "current" });
  });

  it("[MUST-FAIL] the list is read at the base: a change that drops an entry is judged by the list it would replace", async () => {
    const { protectedHits, protectedListAt } = await import("./git-commit");
    const r = join(T, "scope-base");
    g(T, "init", "-q", "-b", "dev", r);
    mkdirSync(join(r, "scripts", "substrate"), { recursive: true });
    writeFileSync(join(r, "scripts", "substrate", "autonomy-scope.json"), SCOPE(["scripts/substrate/", ".claude/"]));
    commitAll(r, "base");
    const base = g(r, "rev-parse", "HEAD");
    writeFileSync(join(r, "scripts", "substrate", "autonomy-scope.json"), SCOPE(["scripts/substrate/"]));
    writeFileSync(join(r, "x"), "x\n");
    commitAll(r, "drops .claude/");
    const at = (ref: string) => async (path: string) => { try { return g(r, "show", `${ref}:${path}`); } catch { return null; } };
    const list = await protectedListAt(at(base), "base");
    if ("error" in list) throw new Error(list.error);
    expect(protectedHits([".claude/hooks/gate.sh", "scripts/substrate/autonomy-scope.json", "scripts/substrate-x/y"], "super", list.excluded))
      .toEqual([".claude/hooks/gate.sh (protected: .claude/)", "scripts/substrate/autonomy-scope.json (protected: scripts/substrate/)"]);
    // an empty or missing list is an error, never no hits
    expect("error" in (await protectedListAt(async () => null, "base"))).toBe(true);
    expect("error" in (await protectedListAt(async () => SCOPE([]), "base"))).toBe(true);
  });
});

describe("git_commit and git_land: a vessel's change is judged by the list current now, not its clone's base", () => {
  const graderOn = (tree: string, id: string): Row[] => [ask,
    { id: `gd-${id}`, shape: "gitDiff", role: "walk", repo: "demo", tree, input_refs: ["ask1"], typecheck: TC_OK, suite: SUITE_OK } as Row,
    { id, shape: "land_verdict", repo: "demo", tree, role: "described", r: 1, input_refs: ["ask1", `gd-${id}`] } as Row];
  const BASE_LIST = ["scripts/substrate/", ".claude/", "repos/demo/protected/"];
  const scopeAt = (excluded: string[], m: string): string => {
    // a leg may have removed the list, and git with it the emptied directory
    mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true });
    writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), SCOPE(excluded));
    // a commit even when the list is as it was: each names its own point in the super's history
    g(SUPER, "add", "-A"); g(SUPER, "commit", "-q", "--allow-empty", "-m", m);
    return g(SUPER, "rev-parse", "HEAD");
  };
  /** A clone made while the super base's list is `atBase`, then the gate accepts a super commit whose list is `now`. */
  const cloneThenList = async (atBase: string[], now: string[]): Promise<{ cwd: string; accepted: string }> => {
    scopeAt(atBase, "the list a clone is made under");
    g(COPY, "pull", "-q", "origin", "dev");
    const w = await makeWorktree("demo");
    if ("error" in w) throw new Error(w.error);
    made.set(w.cwd, w); asOwner(w.cwd);
    const accepted = scopeAt(now, "the list the gate accepts later");
    expect(w.super_base).not.toBe(accepted);
    marker({ schema: 1, gated: true, source: "accepted", accepted_sha: accepted });
    return { cwd: w.cwd, accepted };
  };
  const put = (cwd: string, file: string) => { mkdirSync(join(cwd, file, ".."), { recursive: true }); writeFileSync(join(cwd, file), `export const v = "${file}"\n`); };
  const restore = () => { marker(UNGATED); scopeAt(BASE_LIST, "list restored"); };

  // a vessel's main file the person unprotected, in a clone made while its super base still listed it
  scanned("[MUST-FAIL] a path the person unprotected after the clone was made commits, and lands on a grader's r 1", async () => {
    try {
      const { cwd } = await cloneThenList([...BASE_LIST, "repos/demo/src/index.ts"], BASE_LIST);
      put(cwd, "src/index.ts");
      const c = await commitInClone(cwd, "fix index", undefined, find) as { error?: string; out_of_reach?: string[]; tree?: string };
      expect(c.error).toBeUndefined();
      expect(c.out_of_reach).toBeUndefined();
      table = graderOn(String(c.tree), "cl1");
      expect("pushed" in (await landClone(cwd, deps))).toBe(true);
    } finally { restore(); }
  });

  scanned("[GUARD] a path still on the current list is refused at commit and at land", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      put(cwd, "protected/y.ts");
      const c = await commitInClone(cwd, "y", undefined, find) as { error?: string; out_of_reach?: string[] };
      expect(c.out_of_reach).toEqual(["protected/y.ts (protected: repos/demo/protected/)"]);
      commitAll(cwd, "slipped in by hand");
      table = graderOn(g(cwd, "rev-parse", "HEAD^{tree}"), "cl2");
      const r = await landClone(cwd, deps) as { error?: string; out_of_reach?: string[] };
      expect(r.out_of_reach).toEqual(["protected/y.ts (protected: repos/demo/protected/)"]);
    } finally { restore(); }
  });

  scanned("[MUST-FAIL] a path protected after the clone was made is refused at commit and at land", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, [...BASE_LIST, "repos/demo/later/"]);
      put(cwd, "later/z.ts");
      const c = await commitInClone(cwd, "z", undefined, find) as { error?: string; out_of_reach?: string[] };
      expect(c.out_of_reach).toEqual(["later/z.ts (protected: repos/demo/later/)"]);
      commitAll(cwd, "slipped in by hand");
      table = graderOn(g(cwd, "rev-parse", "HEAD^{tree}"), "cl3");
      const r = await landClone(cwd, deps) as { error?: string; out_of_reach?: string[] };
      expect(r.out_of_reach).toEqual(["later/z.ts (protected: repos/demo/later/)"]);
    } finally { restore(); }
  });

  // Each marker or list state that vouches for no current list refuses the commit, never the clone's base read instead
  // (the base here protects nothing the change touches, so a fallback would commit).
  const NO_LIST: Array<[string, (accepted: string) => unknown]> = [
    ["no marker", () => null],
    ["a marker that is not JSON", () => "{ not json"],
    ["a marker that is not an object", () => [1]],
    ["another schema", (a) => ({ schema: 2, gated: true, source: "accepted", accepted_sha: a })],
    ["no schema", (a) => ({ gated: true, source: "accepted", accepted_sha: a })],
    ["gated with no usable accepted copy (source none), though it names a commit the clone holds", (a) => ({ schema: 1, gated: true, source: "none", accepted_sha: a })],
    ["gated, source clone, though it names a commit the clone holds", (a) => ({ schema: 1, gated: true, source: "clone", accepted_sha: a })],
    ["ungated, source accepted", (a) => ({ schema: 1, gated: false, source: "accepted", accepted_sha: a })],
    ["an accepted sha that is not 40 hex", (a) => ({ schema: 1, gated: true, source: "accepted", accepted_sha: a.slice(0, 12) })],
    ["an accepted sha in capitals", (a) => ({ schema: 1, gated: true, source: "accepted", accepted_sha: a.toUpperCase() })],
    ["an accepted commit the super clone does not hold", () => ({ schema: 1, gated: true, source: "accepted", accepted_sha: "0".repeat(40) })],
  ];
  for (const [name, m] of NO_LIST) {
    it(`[MUST-FAIL] ${name}: the current list cannot be read and the commit is refused`, async () => {
      try {
        const { cwd, accepted } = await cloneThenList(BASE_LIST, BASE_LIST);
        const v = m(accepted);
        if (v === null) rmSync(join(GATE_PUBLIC, "source.json")); else marker(v);
        put(cwd, "free.ts");
        const c = await commitInClone(cwd, "free", undefined, find) as { error?: string; sha?: string; unserved?: string };
        expect(c.sha).toBeUndefined();
        expect(String(c.error)).toContain("the current protected list cannot be read");
        // the node's state, not the change's: records blames the callee, and no request's chain is debited
        expect(c.unserved).toBe("protect_list");
      } finally { restore(); }
    });
  }

  it("[GUARD] a super-repo change is judged by the list at its super base, not the current one: a path only the accepted list names commits", async () => {
    try {
      scopeAt(BASE_LIST, "the list a super clone is made under");
      const s = await makeWorktree("super");
      if ("error" in s) throw new Error(s.error);
      made.set(s.cwd, s); asOwner(s.cwd);
      const accepted = scopeAt([...BASE_LIST, "docs/"], "the accepted list protects docs/");
      marker({ schema: 1, gated: true, source: "accepted", accepted_sha: accepted });
      mkdirSync(join(s.cwd, "docs"), { recursive: true });
      writeFileSync(join(s.cwd, "docs", "a.md"), "a\n");
      const c = await commitInClone(s.cwd, "a doc", undefined, find) as { error?: string; out_of_reach?: string[]; sha?: string };
      expect(c.out_of_reach).toBeUndefined();
      expect(c.error).toBeUndefined();
    } finally { restore(); }
  });

  it("[MUST-FAIL] an accepted commit that holds no list refuses the commit, never reads another commit's list", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      g(SUPER, "rm", "-q", "scripts/substrate/autonomy-scope.json");
      g(SUPER, "commit", "-q", "-m", "an accepted commit with no list");
      marker({ schema: 1, gated: true, source: "accepted", accepted_sha: g(SUPER, "rev-parse", "HEAD") });
      // the clone's HEAD holds a list again, so reading anything but the accepted commit would find one
      scopeAt(BASE_LIST, "the list back after the accepted commit");
      put(cwd, "free.ts");
      const c = await commitInClone(cwd, "free", undefined, find) as { error?: string; sha?: string; unserved?: string };
      expect(c.sha).toBeUndefined();
      expect(c.unserved).toBe("protect_list");
    } finally { restore(); }
  });

  it("[MUST-FAIL] an accepted commit the super clone has not fetched is said as that", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      marker({ schema: 1, gated: true, source: "accepted", accepted_sha: "0".repeat(40) });
      put(cwd, "free.ts");
      const c = await commitInClone(cwd, "free", undefined, find) as { error?: string };
      expect(String(c.error)).toContain(`the super-repo clone does not hold the accepted commit ${"0".repeat(12)}`);
    } finally { restore(); }
  });

  scanned("[MUST-FAIL] with no current list, git_land refuses as the node's state: unserved protect_list, nothing pushed", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      put(cwd, "free2.ts");
      const c = await commitInClone(cwd, "free2", undefined, find) as { tree?: string };
      table = graderOn(String(c.tree), "cl4");
      rmSync(join(GATE_PUBLIC, "source.json"));
      const before = originHead();
      const r = await landClone(cwd, deps) as { error?: string; unserved?: string; out_of_reach?: string[] };
      expect(String(r.error)).toContain("the current protected list cannot be read");
      expect(r.unserved).toBe("protect_list");
      expect(r.out_of_reach).toBeUndefined();
      expect(originHead()).toBe(before);
    } finally { restore(); }
  });

  it("[MUST-FAIL] an accepted commit whose list is not readable refuses the commit", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), "{ not json\n");
      commitAll(SUPER, "an unreadable list accepted");
      marker({ schema: 1, gated: true, source: "accepted", accepted_sha: g(SUPER, "rev-parse", "HEAD") });
      put(cwd, "free.ts");
      const c = await commitInClone(cwd, "free", undefined, find) as { error?: string; sha?: string };
      expect(c.sha).toBeUndefined();
      expect(String(c.error)).toContain("protected list");
    } finally { restore(); }
  });

  it("[MUST-FAIL] ungated, the list is read at the super clone's committed HEAD, never its working tree, and counts only when it protects itself", async () => {
    try {
      const { cwd } = await cloneThenList(BASE_LIST, BASE_LIST);
      marker(UNGATED);
      // committed HEAD protects later/; a working-tree edit dropping it is not read
      scopeAt([...BASE_LIST, "repos/demo/later/"], "ungated HEAD protects later/");
      writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), SCOPE(BASE_LIST));
      put(cwd, "later/w.ts");
      const c = await commitInClone(cwd, "w", undefined, find) as { error?: string; out_of_reach?: string[] };
      expect(c.out_of_reach).toEqual(["later/w.ts (protected: repos/demo/later/)"]);
      // a committed HEAD list that does not name its own path is no list
      scopeAt([".claude/", "repos/demo/protected/"], "ungated HEAD drops its own path");
      rmSync(join(cwd, "later"), { recursive: true, force: true });
      put(cwd, "free.ts");
      const d = await commitInClone(cwd, "free", undefined, find) as { error?: string; sha?: string; unserved?: string };
      expect(d.sha).toBeUndefined();
      expect(d.unserved).toBe("protect_list");
      expect(String(d.error)).toContain("does not protect scripts/substrate/autonomy-scope.json itself");
    } finally { restore(); }
  });
});

describe("what a gap's check keeps of its test run", () => {
  // 90b4's shape: the failing test's block early, much passing output after it, the summary at the end.
  const passes = (n: number, from: number) => Array.from({ length: n }, (_, i) => `(pass) script runner > case ${from + i} keeps its output in order [${i}.0ms]`).join("\n")
  const block = [
    "error: expect(received).toBe(expected)",
    "",
    'Expected: "commit_unavailable"',
    'Received: "no_super_repo_clone"',
    "",
    "      at <anonymous> (src/script-runner.test.ts:88:5)",
    "(fail) MUST-FAIL (3): what runs is the approved commit, never the working tree > no super-repo clone on this node -> refused [3.10ms]",
  ].join("\n")
  const run = ["src/script-runner.test.ts:", passes(20, 0), block, passes(160, 20), "", " 180 pass", " 1 fail", "Ran 111 tests across 1 files. [2.41s]"].join("\n")
  it("[MUST-FAIL] a run longer than the bound keeps the first failing test's assertion whole, and the summary", async () => {
    const { keptCheckOut } = await import("./git-land")
    expect(run.length).toBeGreaterThan(4096 * 2)
    expect(run.slice(-4096)).not.toContain('Expected: "commit_unavailable"') // a plain tail cut loses it
    const kept = keptCheckOut(run, 4096)
    expect(kept.length).toBeLessThanOrEqual(4096)
    expect(kept).toContain('Expected: "commit_unavailable"\nReceived: "no_super_repo_clone"')
    expect(kept).toContain("(fail) MUST-FAIL (3): what runs is the approved commit")
    expect(kept).toContain(" 1 fail")
    expect(kept.startsWith("error: expect(received).toBe(expected)")).toBe(true) // the block starts after the last result line
  })
  it("[MUST-FAIL] of two failing tests, the first's assertion is the one kept, never the second's", async () => {
    const { keptCheckOut } = await import("./git-land")
    const failing = (name: string, want: string, got: string) => [
      "error: expect(received).toBe(expected)", "", `Expected: "${want}"`, `Received: "${got}"`, "",
      `(fail) ${name} [1.00ms]`].join("\n")
    const two = ["src/script-runner.test.ts:", passes(5, 0), failing("first > refuses", "FIRST_WANTED", "FIRST_GOT"), passes(10, 5),
      failing("second > refuses", "SECOND_WANTED", "SECOND_GOT"), passes(160, 15), "", " 175 pass", " 2 fail"].join("\n")
    expect(two.length).toBeGreaterThan(4096 * 2)
    expect(two.slice(-4096)).not.toContain("SECOND_WANTED") // the end alone holds neither
    const kept = keptCheckOut(two, 4096)
    expect(kept).toContain('Expected: "FIRST_WANTED"\nReceived: "FIRST_GOT"')
    expect(kept).not.toContain("SECOND_WANTED")
    expect(kept).toContain(" 2 fail")
  })
  it("[GUARD] a run of exactly the bound is kept whole, and a block too long to leave room for the summary is kept alone", async () => {
    const { keptCheckOut } = await import("./git-land")
    const small = "(pass) a\n(fail) b\n 1 fail"
    expect(keptCheckOut(small, small.length)).toBe(small)
    const fail = run.indexOf("error: expect(received)")
    const own = run.slice(fail, run.indexOf("[3.10ms]", fail) + "[3.10ms]".length)
    for (const room of [2, 3]) {
      const kept = keptCheckOut(run, own.length + room) // no room for the gap and any summary: the block alone
      expect(kept).toBe(own)
    }
  })
  it("[MUST-FAIL] a failing test's block longer than the bound keeps its end: the assertion and the \"(fail)\" line", async () => {
    const { keptCheckOut } = await import("./git-land")
    const logged = Array.from({ length: 300 }, (_, i) => `console: step ${i} of the runner wrote this line`).join("\n")
    const long = ["src/script-runner.test.ts:", passes(5, 0), logged, block, passes(5, 5), " 10 pass", " 1 fail"].join("\n")
    expect(logged.length).toBeGreaterThan(4096)
    const kept = keptCheckOut(long, 4096)
    expect(kept.length).toBeLessThanOrEqual(4096)
    expect(kept).toContain('Expected: "commit_unavailable"\nReceived: "no_super_repo_clone"')
    expect(kept).toContain("(fail) MUST-FAIL (3): what runs is the approved commit")
  })
  it("a run within the bound is kept whole, and one with no failing test keeps its end (a guard)", async () => {
    const { keptCheckOut } = await import("./git-land")
    expect(keptCheckOut("(pass) a\n 1 pass", 4096)).toBe("(pass) a\n 1 pass")
    const green = [passes(200, 0), " 200 pass", " 0 fail"].join("\n")
    expect(keptCheckOut(green, 4096)).toBe(green.slice(-4096))
  })
})

describe("what the whole suite keeps of a run whose tests regressed", () => {
  // bun's report of two files with a test of the same "describe > test" name failing in each: its output prints both
  // failures alike ("(fail) same > name"), its report names each with its file and keeps each one's assertion.
  const failure = (want: string, got: string) => `<failure type="AssertionError" message="expect(received).toBe(expected)&#10;&#10;Expected: ${want}&#10;Received: ${got}&#10;">AssertionError</failure>`;
  const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<testsuites name="bun test" tests="4" failures="3">',
    '<testsuite name="src/a.test.ts" file="src/a.test.ts">', '<testsuite name="same" file="src/a.test.ts">',
    `<testcase name="name" classname="same" file="src/a.test.ts">${failure("&quot;A_WANT&quot;", "&quot;A_GOT&quot;")}</testcase>`,
    '<testcase name="ok" classname="same" file="src/a.test.ts" />', "</testsuite>", "</testsuite>",
    '<testsuite name="src/b.test.ts" file="src/b.test.ts">', '<testsuite name="same" file="src/b.test.ts">',
    `<testcase name="name" classname="same" file="src/b.test.ts">${failure("&quot;B_WANT&quot;", "&quot;B_GOT&quot;")}</testcase>`, "</testsuite>",
    `<testcase name="top level" classname="" file="src/b.test.ts">${failure("3", "2")}</testcase>`,
    '<testcase name="skipped one" classname="" file="src/b.test.ts"><skipped /></testcase>', "</testsuite>", "</testsuites>"].join("\n");
  const out = ["src/a.test.ts:", "error: expect(received).toBe(expected)", "", 'Expected: "A_WANT"', 'Received: "A_GOT"', "(fail) same > name [0.16ms]",
    ...Array.from({ length: 200 }, (_, i) => `(pass) other > case ${i} [0.01ms]`), "src/b.test.ts:", 'Expected: "B_WANT"', 'Received: "B_GOT"',
    "(fail) same > name [0.04ms]", "(fail) top level [0.03ms]", "", " 201 pass", " 3 fail", "Ran 204 tests across 2 files. [3.00ms]"].join("\n");
  it("[MUST-FAIL] the report keeps each failed test's assertion under its file's name, and its passes as before", async () => {
    const { reportOf, passedIn } = await import("./git-land");
    const r = reportOf(xml, true);
    expect(r.failed.get("src/a.test.ts > same > name")).toBe('expect(received).toBe(expected)\n\nExpected: "A_WANT"\nReceived: "A_GOT"\n');
    expect(r.failed.get("src/b.test.ts > same > name")).toContain('Expected: "B_WANT"');
    expect(r.failed.get("src/b.test.ts > top level")).toContain("Expected: 3\nReceived: 2");
    expect([...r.failed.keys()].sort()).toEqual(["src/a.test.ts > same > name", "src/b.test.ts > same > name", "src/b.test.ts > top level"]);
    expect([...r.passed]).toEqual(["src/a.test.ts > same > ok"]);
    expect(passedIn(xml, true)).toEqual(r.passed);
  });
  it("[MUST-FAIL] each regressed test is told by its own assertion, a second file's same-named test by its own, then the run's summary", async () => {
    const { reportOf, regressedOut } = await import("./git-land");
    const kept = regressedOut(["src/a.test.ts > same > name", "src/b.test.ts > same > name"], reportOf(xml, true).failed, out, 4096);
    expect(out.length).toBeGreaterThan(4096);
    expect(kept.length).toBeLessThanOrEqual(4096);
    expect(kept).toContain('(fail) src/a.test.ts > same > name\nexpect(received).toBe(expected)\n\nExpected: "A_WANT"\nReceived: "A_GOT"');
    expect(kept).toContain('(fail) src/b.test.ts > same > name\nexpect(received).toBe(expected)\n\nExpected: "B_WANT"\nReceived: "B_GOT"');
    expect(kept.indexOf("A_WANT")).toBeLessThan(kept.indexOf("B_WANT"));
    expect(kept).toContain(" 3 fail");
  });
  it("[MUST-FAIL] past the bound: whole entries while they fit, none over half, the rest counted, and never longer than max", async () => {
    const { regressedOut } = await import("./git-land");
    const names = Array.from({ length: 30 }, (_, i) => `src/x.test.ts > d > t${i}`);
    const failed = new Map(names.map((n, i) => [n, `Expected: ${i}\nReceived: ${"r".repeat(i === 0 ? 5000 : 200)}`]));
    const kept = regressedOut(names, failed, out, 4096);
    expect(kept.length).toBeLessThanOrEqual(4096);
    expect(kept.startsWith(`(fail) ${names[0]}\nExpected: 0\nReceived: rrr`)).toBe(true);
    expect(kept.indexOf(`(fail) ${names[1]}\n`)).toBeLessThan(2048 + 64); // the first took no more than half
    expect(kept).toMatch(/…and \d+ more regressed, named in regressed/);
  });
  it("[GUARD] with no regressed test, or none in the report (it did not parse, or it is missing), the run's output is kept as it always was", async () => {
    const { regressedOut, keptCheckOut, reportOf } = await import("./git-land");
    expect(regressedOut([], reportOf(xml, true).failed, out, 4096)).toBe(keptCheckOut(out, 4096));
    expect(regressedOut(["src/a.test.ts > same > name"], reportOf("not a report", true).failed, out, 4096)).toBe(keptCheckOut(out, 4096));
    expect(regressedOut(["src/a.test.ts > same > name"], new Map(), out, 4096)).toBe(keptCheckOut(out, 4096));
    // one of two in the report: the other is said to have no failure there, never left out
    const one = regressedOut(["src/a.test.ts > same > name", "src/c.test.ts > gone"], reportOf(xml, true).failed, out, 4096);
    expect(one).toContain("(fail) src/c.test.ts > gone\n(no failure under this name in the tree's report: skipped there, or not run)");
  });
});

// A super-repo origin of its own for a describe: a bare repository seeded with `files`, the owner's repository row naming
// its working branch while the describe runs, and super clones of it with one committed change and a person's r 1 on it.
const superOrigin = (name: string, files: Record<string, string>) => {
  const origin = join(T, `${name}.git`);
  const seed = join(T, `${name}-seed`);
  const write = (dir: string, edits: Record<string, string | null>) => {
    for (const [p, text] of Object.entries(edits)) {
      if (text === null) rmSync(join(dir, p));
      else { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), text, { mode: 0o755 }); }
    }
  };
  let n = 0;
  let keepRepos: Row[] = [];
  beforeAll(() => {
    keepRepos = repoRows;
    repoRows = [...repoRows, { id: "repo-super", seq: 1, shape: "repository", role: "owner", repo: "super", branch: "dev" } as Row];
    g(T, "init", "-q", "--bare", "-b", "dev", origin);
    g(T, "clone", "-q", origin, seed);
    write(seed, files);
    commitAll(seed, "super origin"); g(seed, "push", "-q", "origin", "HEAD:dev");
  });
  afterAll(() => { repoRows = keepRepos; });
  return {
    /** origin's branch moved by one commit: each path written, or removed when null. */
    moveOrigin: (edits: Record<string, string | null>) => {
      g(seed, "pull", "-q", "origin", "dev");
      write(seed, edits);
      commitAll(seed, "origin moves"); g(seed, "push", "-q", "origin", "HEAD:dev");
    },
    /** A super clone of origin's branch with one committed change; its tree, with a person's r 1 on it. */
    superChange: (edits: Record<string, string | null>, before?: (cwd: string) => void): { cwd: string; tree: string } => {
      const cwd = join(T, "clones", `${name}-${++n}`);
      g(T, "clone", "-q", "-b", "dev", origin, cwd);
      made.set(cwd, { cwd, repo: "super", branch: "dev", base: g(cwd, "rev-parse", "HEAD"), super_base: g(SUPER, "rev-parse", "HEAD"), origin_url: origin });
      write(cwd, edits);
      before?.(cwd);
      commitAll(cwd, "super change");
      asOwner(cwd);
      const tree = g(cwd, "rev-parse", "HEAD^{tree}");
      table = personOn(tree, `v-${name}-${n}`).map((r) => ({ ...r, repo: "super" }) as Row);
      return { cwd, tree };
    },
    superHead: () => g(origin, "rev-parse", "dev"),
    tree: () => g(origin, "rev-parse", "dev^{tree}"),
  };
};

// A change onto the super-repo may not widen the node gate's authority. What counts as a widening is the super-repo's
// rule (scripts/substrate/gate/widening.sh, tested there); here it is a stand-in that says which policy it was handed
// and which commits it compared, and answers as the rule does: 1 with a line per widening, 0 none, 2 cannot judge.
describe("git_land onto the super-repo: the gate's authority only narrows", () => {
  const CALLS = join(OUT, "widening-calls.txt");
  const VIEW = join(OUT, "widening-git-view.txt");
  const RULE = '#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do case "$1" in --policy) P="$2"; shift ;; --super) S="$2"; shift ;; --base) B="$2"; shift ;; --head) H="$2"; shift ;; esac; shift; done\n' +
    `mode="$(jq -r .mode "$P")"\necho "$mode $B $H" >> "${CALLS}"\n` +
    // what the git the rule runs reads of its config: the land's isolation, or a value leaked from outside it
    `for k in core.fsmonitor protocol.allow core.hooksPath test.leak; do printf '%s=%s;' "$k" "$(git -C "$S" config --get "$k")"; done >> "${VIEW}"; ` +
    `printf 'nosystem=%s;system=%s;home=%s;' "$GIT_CONFIG_NOSYSTEM" "$GIT_CONFIG_SYSTEM" "$HOME" >> "${VIEW}"; echo >> "${VIEW}"\n` +
    '[ "$mode" = unjudgeable ] && { echo "cannot judge: the policy says so"; exit 2; }\n[ "$mode" = lax ] && exit 0\n' +
    'git -C "$S" diff --name-status --no-renames "$B" "$H" | awk -F"\\t" \'$1 != "A" && $2 ~ /^gate\\/fixtures\\// { print "fixture " $1 ": " $2; n++ } END { exit n > 0 }\'\n';
  const POLICY = (mode: string) => JSON.stringify({ mode }) + "\n";
  const files: Record<string, string> = {
    "scripts/substrate/gate/widening.sh": RULE, "scripts/substrate/gate/gate-policy.json": POLICY("strict"),
    "scripts/substrate/autonomy-scope.json": SCOPE(["scripts/substrate/autonomy-scope.json"]), "gate/fixtures/accepted.json": "{}\n", "README.md": "super\n",
  };
  const { moveOrigin, superChange, superHead, tree: originTree } = superOrigin("super-origin", files);
  const calls = () => (existsSync(CALLS) ? Bun.file(CALLS).text() : Promise.resolve("")).then((t) => t.split("\n").filter(Boolean));

  scanned("[MUST-FAIL] a change that edits an accepted gate fixture is refused as a widening, even on a person's r 1, naming it", async () => {
    const before = superHead();
    const { cwd } = superChange({ "gate/fixtures/accepted.json": '{"loosened":true}\n' });
    const r = await landClone(cwd, deps) as { error: string; widening?: string[] };
    expect(r.error).toBe("authority_widening: fixture M: gate/fixtures/accepted.json");
    expect(r.widening).toEqual(["fixture M: gate/fixtures/accepted.json"]);
    expect(superHead()).toBe(before);
    // judged with origin's policy, origin's branch as the base and the change as the head
    expect((await calls()).at(-1)).toBe("strict refs/remotes/origin/dev refs/land/head");
  });

  scanned("[MUST-FAIL] the rule's git reads only the land's isolation: no fsmonitor, no transport, no hooks, nothing from a system config", async () => {
    const sys = join(T, "hostile-system-gitconfig");
    const ran = join(OUT, "system-config-ran");
    writeFileSync(join(T, "hostile.sh"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
    writeFileSync(sys, `[test]\n\tleak = yes\n[core]\n\tfsmonitor = ${join(T, "hostile.sh")}\n\thooksPath = ${T}\n[protocol]\n\tallow = always\n`);
    // and what this process carries for git: a system config path, and config given as if by -c
    const keep = { sys: process.env.GIT_CONFIG_SYSTEM, params: process.env.GIT_CONFIG_PARAMETERS };
    process.env.GIT_CONFIG_SYSTEM = sys;
    process.env.GIT_CONFIG_PARAMETERS = "'test.leak'='yes'";
    const before = superHead();
    try {
      const { cwd } = superChange({ "gate/fixtures/accepted.json": '{"seen":1}\n' });
      expect(String((await landClone(cwd, deps) as { error: string }).error)).toBe("authority_widening: fixture M: gate/fixtures/accepted.json");
    } finally {
      for (const [k, v] of [["GIT_CONFIG_SYSTEM", keep.sys], ["GIT_CONFIG_PARAMETERS", keep.params]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
    const view = readFileSync(VIEW, "utf8").trim().split("\n").at(-1) ?? "";
    expect(view).toMatch(/^core\.fsmonitor=false;protocol\.allow=never;core\.hooksPath=\/.+;test\.leak=;nosystem=1;system=\/dev\/null;home=\/.+;$/);
    expect(view).not.toContain(`core.hooksPath=${T};`);
    // HOME is the land's own fresh directory, never this process's, so no user config is read either
    expect(view).not.toContain(`home=${process.env.HOME ?? "/nonexistent-home"};`);
    expect(existsSync(ran)).toBe(false);
    expect(superHead()).toBe(before);
  });

  scanned("[MUST-FAIL] the change's own rule and policy never judge it: rewriting both to pass still refuses", async () => {
    const before = superHead();
    const { cwd } = superChange({ "gate/fixtures/accepted.json": "[]\n", "scripts/substrate/gate/widening.sh": "#!/bin/sh\nexit 0\n",
      "scripts/substrate/gate/gate-policy.json": POLICY("lax") });
    expect(String((await landClone(cwd, deps) as { error: string }).error)).toBe("authority_widening: fixture M: gate/fixtures/accepted.json");
    expect(superHead()).toBe(before);
  });

  scanned("[MUST-FAIL] a rule that cannot judge the change, or no rule at origin, refuses: never read as no widening", async () => {
    try {
      moveOrigin({ "scripts/substrate/gate/gate-policy.json": POLICY("unjudgeable") });
      const a = superChange({ "README.md": "docs only\n" });
      const before = superHead();
      expect(String((await landClone(a.cwd, deps) as { error: string }).error))
        .toBe("the gate-widening rule could not judge the change (exit 2: cannot judge: the policy says so): nothing lands");
      expect(superHead()).toBe(before);
      moveOrigin({ "scripts/substrate/gate/gate-policy.json": POLICY("strict"), "scripts/substrate/gate/widening.sh": null });
      const b = superChange({ "README.md": "docs only\n" });
      expect(String((await landClone(b.cwd, deps) as { error: string }).error)).toContain("has no scripts/substrate/gate/widening.sh");
      moveOrigin({ "scripts/substrate/gate/gate-policy.json": null, "scripts/substrate/gate/widening.sh": RULE });
      const c = superChange({ "README.md": "docs only\n" });
      expect(String((await landClone(c.cwd, deps) as { error: string }).error)).toContain("has no scripts/substrate/gate/gate-policy.json");
    } finally {
      moveOrigin({ "scripts/substrate/gate/gate-policy.json": POLICY("strict"), "scripts/substrate/gate/widening.sh": RULE });
    }
  });

  scanned("[GUARD] a key in a super-repo doc is refused by the scan's rule, an inline allow comment notwithstanding; origin does not move", async () => {
    const secret = ["mb", "_", "R".repeat(20), "y".repeat(20)].join("");
    const before = superHead();
    for (const text of [`token: ${secret}\n`, `token: ${secret} # gitleaks:allow\n`]) {
      const { cwd } = superChange({ "docs/setup.md": text });
      const r = await landClone(cwd, deps) as { error: string; rules?: string[] };
      expect([r.error, r.rules]).toEqual(["the secrets scan found something in the change", ["substrate-api-key"]]);
      expect(JSON.stringify(r)).not.toContain(secret);
    }
    expect(superHead()).toBe(before);
  });

  scanned("a docs-only change, and a new gate fixture, are no widening: each lands on a person's r 1 (controls)", async () => {
    const docs = superChange({ "README.md": "a docs-only change\n" });
    const d = await landClone(docs.cwd, deps);
    expect("pushed" in d ? d.changed : JSON.stringify(d)).toEqual(["README.md"]);
    expect(originTree()).toBe(docs.tree);
    const added = superChange({ "gate/fixtures/new.json": "{}\n" });
    const a = await landClone(added.cwd, deps);
    expect("pushed" in a ? a.changed : JSON.stringify(a)).toEqual(["gate/fixtures/new.json"]);
  });
});

// The same check with the super-repo's real rule, as committed there (test/fixtures/gate/widening.sh, copied byte for
// byte), and a gate policy with the keys it reads: a stand-in alone could pass while the rule's arguments, exit codes
// or lines differ from what git_land reads.
describe("git_land onto the super-repo, judged by the real widening rule", () => {
  const FIX = join(import.meta.dir, "..", "test", "fixtures", "gate");
  const POLICY = readFileSync(join(FIX, "gate-policy.json"), "utf8");
  const ACCEPTED = "validation/scripts/gate/fixtures/accepted.json";
  const { superChange, superHead, tree: originTree } = superOrigin("super-real", {
    "scripts/substrate/gate/widening.sh": readFileSync(join(FIX, "widening.sh"), "utf8"), "scripts/substrate/gate/gate-policy.json": POLICY,
    "scripts/substrate/autonomy-scope.json": SCOPE(["scripts/substrate/autonomy-scope.json"]), [ACCEPTED]: "{}\n", "README.md": "super\n",
  });
  const EDITED = `authority_widening: M ${ACCEPTED} (accepted fixture edited or removed)`;

  scanned("[MUST-FAIL] an accepted fixture edited, a gate path dropped or the soak lowered is refused, each named as the rule names it", async () => {
    const before = superHead();
    expect((await landClone(superChange({ [ACCEPTED]: "[]\n" }).cwd, deps) as { error: string }).error).toBe(EDITED);
    const loosened = JSON.parse(POLICY) as { gate_paths: string[]; soak_ticks: { default: number } };
    loosened.gate_paths = loosened.gate_paths.filter((p) => p !== "validation/scripts/*");
    loosened.soak_ticks.default = 0;
    const r = await landClone(superChange({ "scripts/substrate/gate/gate-policy.json": JSON.stringify(loosened) }).cwd, deps) as { error: string; widening?: string[] };
    expect(r.widening).toEqual(["scripts/substrate/gate/gate-policy.json drops gate_paths entry 'validation/scripts/*'",
      "scripts/substrate/gate/gate-policy.json lowers soak_ticks.default 1 -> 0"]);
    expect(superHead()).toBe(before);
  });

  scanned("[MUST-FAIL] what the change's clone configures never runs while the rule judges, and the verdict is the same", async () => {
    const before = superHead();
    const ran = join(OUT, "clone-config-ran");
    const { cwd } = superChange({ [ACCEPTED]: '{"x":1}\n', ".gitattributes": "* diff=evil\n" });
    writeFileSync(join(cwd, "evil.sh"), `#!/bin/sh\ntouch "${ran}"\n`, { mode: 0o755 });
    g(cwd, "config", "diff.evil.textconv", join(cwd, "evil.sh"));
    g(cwd, "config", "core.fsmonitor", join(cwd, "evil.sh"));
    asOwner(cwd);
    const r = await landClone(cwd, deps) as { error: string };
    expect(r.error).toBe(EDITED);
    expect(existsSync(ran)).toBe(false);
    expect(superHead()).toBe(before);
  });

  scanned("a README-only change and a new fixture are no widening under the real rule: each lands (controls)", async () => {
    const docs = superChange({ "README.md": "a docs-only change\n" });
    expect("pushed" in (await landClone(docs.cwd, deps))).toBe(true);
    expect(originTree()).toBe(docs.tree);
    const added = superChange({ "validation/scripts/gate/fixtures/new.json": "{}\n" });
    expect("pushed" in (await landClone(added.cwd, deps))).toBe(true);
    expect(originTree()).toBe(added.tree);
  });
});
