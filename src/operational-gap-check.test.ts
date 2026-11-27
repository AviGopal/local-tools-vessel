// Operational gap checks: a detector gap without evidence_resolve or meta.regression (walk_failure, self_check,
// resolver_graduation) requires both a non-test source fix and at least one [MUST-FAIL] *.test.* file that fails on the
// base (with test support overlaid) and passes on the change without regressing previously passing tests.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitInClone } from "./git-commit";
import { diffClone, gapOf, isGapCheckFile, landClone } from "./git-land";
import { makeWorktree } from "./git-worktree";
import type { Made, Query, Row } from "./walk-rows";

setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "operational-gap-check-test-"));
// Run as root, the tools' git and checks drop to the shell user, which must traverse this test directory.
chmodSync(T, 0o755);
const OUT = join(T, "out");
mkdirSync(OUT, { mode: 0o777 });
chmodSync(OUT, 0o777);

const ENV_KEYS = ["SUPER_REPO_DIR", "PULLSYNC_GATE_PUBLIC_DIR", "MITOSIS_PUSH_CLONE_DIR", "MITOSIS_RUNTIME_DIR", "WALK_TREES_DIR",
  "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "PATH"];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const asOwner = (cwd: string) => {
  g(cwd, "config", "user.name", "t");
  g(cwd, "config", "user.email", "t@t");
  if (process.getuid?.() === 0) Bun.spawnSync(["chown", "-R", "65534:65534", cwd]);
};
const commitAll = (cwd: string, m: string) => { g(cwd, "add", "-A"); g(cwd, "commit", "-q", "-m", m); };

const REPO = "opdemo";
const SUPER = join(T, "super");
const ORIGIN = join(T, `${REPO}.git`);
const COPY = join(T, "clones", REPO);
const SEED = join(T, "seed");
const GATE_PUBLIC = join(T, "gate-public");
const CONFIG = 'title = "t"\n\n[extend]\nuseDefault = true\n\n[[rules]]\nid = "substrate-api-key"\nregex = \'\'\'\\bmb[-_][A-Za-z0-9_-]{32,}\'\'\'\n';
const SCOPE = JSON.stringify({ autonomyScope: { excluded_paths: ["scripts/substrate/", ".claude/"] } }) + "\n";
const TSCONFIG = JSON.stringify({
  compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "bundler", strict: true, skipLibCheck: true, types: ["bun-types"] },
  include: ["src/**/*.ts"],
});

const made = new Map<string, Made>();
const find = async (cwd: string) => made.get(cwd) ?? { error: "0 walk rows" };
let table: Row[] = [];
const repoRows: Row[] = [{ id: "repo-opdemo", seq: 1, shape: "repository", role: "owner", repo: REPO, branch: "dev" } as Row];
const rows = async (q: Query): Promise<Row[]> => [...repoRows, ...table].filter((r) =>
  (q.shape === undefined || r.shape === q.shape) && (q.ids === undefined || q.ids.includes(r.id)) &&
  Object.entries(q.where ?? {}).every(([k, v]) => String(r[k]) === String(v)));
const deps = { find, rows, transports: ["file"] };

const changeOf = async (files: Record<string, string | null>): Promise<{ cwd: string; tree: string }> => {
  g(COPY, "pull", "-q", "origin", "dev");
  const w = await makeWorktree(REPO);
  if ("error" in w) throw new Error(w.error);
  made.set(w.cwd, w);
  for (const [f, text] of Object.entries(files)) {
    if (text === null) { rmSync(join(w.cwd, f), { force: true }); continue; }
    mkdirSync(join(w.cwd, f, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(join(w.cwd, f), text, { mode: 0o644 });
  }
  asOwner(w.cwd);
  const c = await commitInClone(w.cwd, "change", undefined, find);
  if (!("tree" in c)) throw new Error(JSON.stringify(c));
  return { cwd: w.cwd, tree: c.tree };
};

const originHead = () => g(ORIGIN, "rev-parse", "dev");
const SCANNER = Bun.which("gitleaks", { PATH: process.env.PATH ?? "" });

beforeAll(() => {
  mkdirSync(GATE_PUBLIC, { mode: 0o755 });
  writeFileSync(join(GATE_PUBLIC, "source.json"), JSON.stringify({ schema: 1, gated: false, source: "clone", accepted_sha: null }) + "\n");
  Object.assign(process.env, {
    SUPER_REPO_DIR: SUPER,
    PULLSYNC_GATE_PUBLIC_DIR: GATE_PUBLIC,
    MITOSIS_PUSH_CLONE_DIR: join(T, "clones"),
    MITOSIS_RUNTIME_DIR: join(T, "runtime"),
    WALK_TREES_DIR: join(T, "trees"),
  });
  mkdirSync(join(T, "runtime", REPO), { recursive: true, mode: 0o755 });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", REPO, "node_modules"));
  for (const [k, v] of Object.entries(gitEnv)) if (k.startsWith("GIT_")) process.env[k] = v;

  mkdirSync(join(SUPER, "scripts", "git-hooks"), { recursive: true, mode: 0o755 });
  g(SUPER, "init", "-q", "-b", "dev");
  for (const h of ["pre-commit", "vessel-pre-commit"]) writeFileSync(join(SUPER, "scripts", "git-hooks", h), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "git-hooks", ".gitleaks.toml"), CONFIG);
  mkdirSync(join(SUPER, "scripts", "substrate"), { recursive: true, mode: 0o755 });
  writeFileSync(join(SUPER, "scripts", "substrate", "autonomy-scope.json"), SCOPE);
  g(SUPER, "remote", "add", "origin", "https://example.invalid/super.git");
  commitAll(SUPER, "super base");

  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  g(T, "clone", "-q", ORIGIN, SEED);
  writeFileSync(join(SEED, "tsconfig.json"), TSCONFIG);
  writeFileSync(join(SEED, "package.json"), JSON.stringify({ name: REPO, private: true }) + "\n");
  mkdirSync(join(SEED, "src"), { recursive: true, mode: 0o755 });
  writeFileSync(join(SEED, "src", "calc.ts"), "export const add = (a: number, b: number): number => a - b;\n");
  writeFileSync(join(SEED, "src", "existing.test.ts"),
    'import { describe, expect, test } from "bun:test";\nimport { add } from "./calc";\n' +
    'describe("existing", () => { test("keeps zero", () => { expect(add(0, 0)).toBe(0); }); });\n');
  commitAll(SEED, "base");
  g(SEED, "push", "-q", "origin", "HEAD:dev");

  mkdirSync(join(T, "clones"), { mode: 0o755 });
  g(T, "clone", "-q", "-b", "dev", ORIGIN, COPY);
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(T, { recursive: true, force: true });
});

describe("operational gap check", () => {
  it("[MUST-FAIL] walk_failure and resolver_graduation gaps pass diffClone with source fix + [MUST-FAIL] test and land on grader r 1", async () => {
    const gapRows = (gapId: string, category: string): Row[] => [
      { id: `gap-${gapId}`, shape: "gap", role: "detector", gap_id: gapId, category, meta: { sources: ["src/calc.ts"] } } as Row,
      { id: `sel-${gapId}`, shape: "selection", role: "walk", root: `gap-${gapId}` } as Row,
    ];
    for (const [gapId, category, testName] of [
      ["OP-WF", "walk_failure", "src/op_wf.test.ts"],
      ["OP-RG", "resolver_graduation", "src/op_rg.test.ts"],
    ] as const) {
      const [gapRow, selRow] = gapRows(gapId, category);
      const gap = await gapOf(async (q) => [gapRow, selRow].filter((r) => q.ids?.includes(r.id)), selRow.id);
      expect(gap).toEqual({ gap_id: gapId, operational: true, only_tests: [], lever: "src/calc.ts" });
      if (!gap || "error" in gap) throw new Error(JSON.stringify(gap));

      const fixSrc = "export const add = (a: number, b: number): number => a + b;\n";
      const mustFailTest = 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\n' +
        'test("adds numbers", () => { expect(add(2, 3)).toBe(5); });\n';
      const { cwd, tree } = await changeOf({ "src/calc.ts": fixSrc, [testName]: mustFailTest });
      const diff = await diffClone(cwd, made.get(cwd)!, ["file"], gap);
      if (!("tree" in diff)) throw new Error(JSON.stringify(diff));

      expect(diff.check).toMatchObject({ gap_id: gapId, test_file: testName, ran: true, passed: true, exit_code: 0, regressed: [] });
      expect(diff.suite).toMatchObject({ ran: true, passed: true, regressed: [] });
      expect(diff.typecheck).toMatchObject({ ran: true, passed: true });

      const diffRow: Row = { id: `diff-${gapId}`, shape: "gitDiff", role: "walk", repo: REPO, tree, input_refs: [gapRow.id],
        typecheck: diff.typecheck, suite: diff.suite, check: diff.check };
      const verdictRow: Row = { id: `v-${gapId}`, shape: "land_verdict", repo: REPO, tree, role: "described", r: 1,
        writer: "described-grader", input_refs: [gapRow.id, diffRow.id] };
      table = [gapRow, diffRow, verdictRow];

      if (SCANNER) {
        const landed = await landClone(cwd, deps);
        if (!("pushed" in landed)) throw new Error(JSON.stringify(landed));
        expect(landed.pushed).toBe(true);
        expect(originHead()).toBe(landed.head);
        // Reset origin back to base calc.ts (with a clean new commit) or update SEED for next loop iteration
        g(SEED, "pull", "-q", "origin", "dev");
        writeFileSync(join(SEED, "src", "calc.ts"), "export const add = (a: number, b: number): number => a - b;\n");
        rmSync(join(SEED, testName), { force: true });
        commitAll(SEED, `reset after ${gapId}`);
        g(SEED, "push", "-q", "origin", "HEAD:dev");
      } else {
        const refused = await landClone(cwd, deps);
        expect("error" in refused && String(refused.error)).toContain("no secrets scanner");
      }
    }
  });

  it("[GUARD] source-only change fails gap_check requiring a [MUST-FAIL] test file", async () => {
    const gap = { gap_id: "OP-1", operational: true as const, only_tests: [] };
    const { cwd } = await changeOf({ "src/calc.ts": "export const add = (a: number, b: number): number => a + b;\n" });
    const diff = await diffClone(cwd, made.get(cwd)!, ["file"], gap);
    if (!("tree" in diff)) throw new Error(JSON.stringify(diff));
    expect(diff.check).toEqual({
      gap_id: "OP-1",
      ran: false,
      passed: false,
      why: "an operational gap fix must include a [MUST-FAIL] *.test.* file that fails on the base and passes on the change",
    });
  });

  it("[GUARD] test-only change fails gap_check requiring non-test source files", async () => {
    const gap = { gap_id: "OP-2", operational: true as const, only_tests: [] };
    const { cwd } = await changeOf({
      "src/only.test.ts": 'import { expect, test } from "bun:test";\ntest("subtracts", () => { expect(1).toBe(1); });\n',
    });
    const diff = await diffClone(cwd, made.get(cwd)!, ["file"], gap);
    if (!("tree" in diff)) throw new Error(JSON.stringify(diff));
    expect(diff.check).toEqual({
      gap_id: "OP-2",
      ran: false,
      passed: false,
      why: "an operational gap fix must change non-test source files, not only tests",
    });
  });

  it("[GUARD] tautological test that passes on base without source fix fails gap_check", async () => {
    const gap = { gap_id: "OP-3", operational: true as const, only_tests: [] };
    const { cwd } = await changeOf({
      "src/calc.ts": "export const add = (a: number, b: number): number => a + b;\n",
      "src/tautology.test.ts": 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\n' +
        'test("zero stays zero", () => { expect(add(0, 0)).toBe(0); });\n',
    });
    const diff = await diffClone(cwd, made.get(cwd)!, ["file"], gap);
    if (!("tree" in diff)) throw new Error(JSON.stringify(diff));
    expect(diff.check).toEqual({
      gap_id: "OP-3",
      test_file: "src/tautology.test.ts",
      ran: true,
      passed: false,
      exit_code: 0,
      out: "the added test already passes on the base: an operational gap fix needs a [MUST-FAIL] test that fails without the source change",
      truncated: false,
      regressed: [],
    });
  });

  it("[GUARD] modifying an existing *.test.ts and breaking an existing passing test flags regressed and fails gap_check", async () => {
    const gap = { gap_id: "OP-4", operational: true as const, only_tests: [] };
    const { cwd } = await changeOf({
      "src/calc.ts": "export const add = (a: number, b: number): number => (a === 0 && b === 0 ? 1 : a + b);\n",
      "src/existing.test.ts":
        'import { describe, expect, test } from "bun:test";\nimport { add } from "./calc";\n' +
        'describe("existing", () => { test("keeps zero", () => { expect(add(0, 0)).toBe(0); }); ' +
        'test("adds", () => { expect(add(2, 3)).toBe(5); }); });\n',
    });
    const diff = await diffClone(cwd, made.get(cwd)!, ["file"], gap);
    if (!("tree" in diff)) throw new Error(JSON.stringify(diff));
    expect(diff.check).toMatchObject({
      gap_id: "OP-4",
      test_file: "src/existing.test.ts",
      ran: true,
      passed: false,
      regressed: ["existing > keeps zero"],
    });
  });

  it("[GUARD] CHECK_CONFIG (package.json) and FORGES (Bun.exit) remain refused for operational gaps", async () => {
    const gap = { gap_id: "OP-5", operational: true as const, only_tests: [] };
    const mustFail = 'import { expect, test } from "bun:test";\nimport { add } from "./calc";\ntest("adds", () => { expect(add(1, 2)).toBe(3); });\n';

    const cfg = await changeOf({
      "src/calc.ts": "export const add = (a: number, b: number): number => a + b;\n",
      "src/new.test.ts": mustFail,
      "package.json": JSON.stringify({ name: REPO, private: true, scripts: {} }) + "\n",
    });
    const cfgDiff = await diffClone(cfg.cwd, made.get(cfg.cwd)!, ["file"], gap);
    if (!("tree" in cfgDiff)) throw new Error(JSON.stringify(cfgDiff));
    expect(cfgDiff.check).toMatchObject({
      gap_id: "OP-5",
      ran: false,
      passed: false,
      why: expect.stringContaining("package.json"),
    });

    const forge = await changeOf({
      "src/calc.ts": "export const add = (a: number, b: number): number => { Bun.exit(0); return a + b; };\n",
      "src/new.test.ts": mustFail,
    });
    const forgeDiff = await diffClone(forge.cwd, made.get(forge.cwd)!, ["file"], gap);
    if (!("tree" in forgeDiff)) throw new Error(JSON.stringify(forgeDiff));
    expect(forgeDiff.check).toMatchObject({
      gap_id: "OP-5",
      ran: false,
      passed: false,
      why: expect.stringContaining("writes what the check reads"),
    });
  });

  it("[GUARD] gapOf resolves operational categories and keeps refusing meta.regression and bare/test categories", async () => {
    const rowsOf = (all: Row[]) => async (q: Query) => all.filter((r) => q.ids?.includes(r.id));
    const sel = { id: "s1", shape: "selection", role: "walk", root: "g1" } as Row;

    for (const category of ["walk_failure", "self_check", "resolver_graduation"]) {
      const gRow = { id: "g1", shape: "gap", role: "detector", gap_id: `G-${category}`, category, meta: { sources: ["src/a.ts"] } } as Row;
      expect(await gapOf(rowsOf([sel, gRow]), "s1")).toEqual({
        gap_id: `G-${category}`,
        operational: true,
        only_tests: [],
        lever: "src/a.ts",
      });
    }

    const regression = { id: "g1", shape: "gap", role: "detector", gap_id: "R0",
      meta: { vessel: REPO, head: "h", refusals: 2, regression: "1 test(s) newly failing" } } as Row;
    expect(await gapOf(rowsOf([sel, regression]), "s1")).toEqual({ error: "gap R0 names no test file" });

    const bare = { id: "g1", shape: "gap", role: "detector", gap_id: "R0", meta: {} } as Row;
    expect(await gapOf(rowsOf([sel, bare]), "s1")).toEqual({ error: "gap R0 names no test file" });

    for (const category of ["failing_test", "typecheck_error"]) {
      const nonOp = { id: "g1", shape: "gap", role: "detector", gap_id: "R0", category, meta: {} } as Row;
      expect(await gapOf(rowsOf([sel, nonOp]), "s1")).toEqual({ error: "gap R0 names no test file" });
    }
  });

  it("[GUARD] isGapCheckFile allows test files on operational gaps, protects CHECK_CONFIG, and blocks test files on failing_test gaps", () => {
    expect(isGapCheckFile("src/new.test.ts", { operational: true })).toBe(false);
    expect(isGapCheckFile("tsconfig.json", { operational: true })).toBe(true);
    expect(isGapCheckFile("package.json", { operational: true })).toBe(true);
    expect(isGapCheckFile("src/calc.test.ts", { test_file: "src/calc.test.ts" })).toBe(true);
  });
});

// Verify fs_edit integration on an operational gap selection vs failing_test gap selection.
describe("fs_edit with operational gap selection", () => {
  it("[GUARD] allows editing/authoring *.test.ts for operational gaps and refuses tsconfig.json", async () => {
    const trees = join(T, "edit-trees");
    const clone = join(trees, "opdemo-vessel-mw1-1a2b3c4d");
    mkdirSync(join(clone, ".git"), { recursive: true, mode: 0o755 });
    mkdirSync(join(clone, "src"), { recursive: true, mode: 0o755 });
    const testPath = join(clone, "src", "new.test.ts");
    const tsPath = join(clone, "tsconfig.json");
    writeFileSync(testPath, 'test("a", () => { expect(1).toBe(2); });\n');
    writeFileSync(tsPath, "{}\n");

    const rowsMap: Record<string, Record<string, unknown>> = {
      "sel-op": { id: "sel-op", shape: "selection", role: "walk", root: "gap-op" },
      "gap-op": { id: "gap-op", shape: "gap", role: "detector", gap_id: "OP-E", category: "walk_failure", meta: { sources: ["src/calc.ts"] } },
    };
    const realFetch = globalThis.fetch;
    const savedEdit = { w: process.env.WALK_TREES_DIR, d: process.env.DISCOVERY_ENDPOINT };
    process.env.WALK_TREES_DIR = trees;
    process.env.DISCOVERY_ENDPOINT = "http://discovery.test";
    globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
      const p = (JSON.parse(String(init?.body ?? "{}")) as { pointer?: { ids?: string[] } }).pointer ?? {};
      return Response.json((p.ids ?? []).map((id) => rowsMap[id]).filter(Boolean));
    }) as typeof fetch;

    try {
      const { resolvers } = await import("./index");
      const edit = (path: string, old_string: string, new_string: string) =>
        resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path, old_string, new_string, selection_ref: "sel-op" } } } } as never) as Promise<Record<string, unknown>>;

      expect(await edit(testPath, "toBe(2)", "toBe(1)")).toMatchObject({ ok: true });
      expect(await edit(tsPath, "{}", '{"strict":false}')).toMatchObject({ refused: "gap_check" });
    } finally {
      globalThis.fetch = realFetch;
      if (savedEdit.w === undefined) delete process.env.WALK_TREES_DIR; else process.env.WALK_TREES_DIR = savedEdit.w;
      if (savedEdit.d === undefined) delete process.env.DISCOVERY_ENDPOINT; else process.env.DISCOVERY_ENDPOINT = savedEdit.d;
    }
  });
});
