// gap_check runs a gap's test file at one commit of origin's branch by git_diff's own runner, and says each named test's
// state from the runner's report. Throwaway repositories; origin is a local bare repository, so the file transport is
// allowed for these tests only.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gapCheckAt } from "./git-land";
import { resolvers } from "./index";
import { SHAPE_ANSWERS, SHAPE_INPUTS, wrapsClone } from "./shape-inputs";

setDefaultTimeout(120_000);
const T = mkdtempSync(join(tmpdir(), "gap-check-test-"));
chmodSync(T, 0o755);
const ORIGIN = join(T, "demo.git");
const SEED = join(T, "seed");
const saved = { clones: process.env.MITOSIS_PUSH_CLONE_DIR, runtime: process.env.MITOSIS_RUNTIME_DIR };
const gitEnv = { PATH: process.env.PATH ?? "", HOME: T, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const g = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", ...args], { cwd, env: { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" }, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
};
const commit = (files: Record<string, string>, m: string, push = true): string => {
  for (const [p, text] of Object.entries(files)) writeFileSync(join(SEED, p), text);
  g(SEED, "add", "-A"); g(SEED, "commit", "-q", "-m", m);
  if (push) g(SEED, "push", "-q", "origin", "HEAD:dev");
  return g(SEED, "rev-parse", "HEAD");
};
const TEST = 'import { expect, test, describe } from "bun:test";\nimport { add } from "./calc";\n' +
  'describe("add", () => { test("adds", () => { expect(add(1, 2)).toBe(3); }); test("zero", () => { expect(add(0, 0)).toBe(0); }); });\n';
const red = "export const add = (a: number, b: number): number => a - b;\n";
const fixed = "export const add = (a: number, b: number): number => a + b;\n";
const ask = (ref: string, more: Record<string, unknown> = {}) =>
  ({ repo: "demo", ref, branch: "dev", test_file: "calc.test.ts", only_tests: ["add > adds"], ...more }) as never;
const opts = { transports: ["file"] };
let base = "";
let green = "";

beforeAll(() => {
  Object.assign(process.env, { MITOSIS_PUSH_CLONE_DIR: join(T, "clones"), MITOSIS_RUNTIME_DIR: join(T, "runtime") });
  // demo's install on this node: this vessel's own
  mkdirSync(join(T, "runtime", "demo"), { recursive: true });
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(T, "runtime", "demo", "node_modules"));
  g(T, "init", "-q", "--bare", "-b", "dev", ORIGIN);
  g(T, "clone", "-q", ORIGIN, SEED);
  base = commit({ "calc.ts": red, "calc.test.ts": TEST }, "a failing check");
  green = commit({ "calc.ts": fixed }, "the fix");
  // the node's copy of demo, which says where its origin is
  mkdirSync(join(T, "clones"));
  g(T, "clone", "-q", "-b", "dev", ORIGIN, join(T, "clones", "demo"));
});
afterAll(() => {
  for (const [k, v] of [["MITOSIS_PUSH_CLONE_DIR", saved.clones], ["MITOSIS_RUNTIME_DIR", saved.runtime]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(T, { recursive: true, force: true });
});

describe("gap_check", () => {
  it("[MUST-FAIL] runs the test file at the commit asked: red where the source is broken, green where it is fixed, each name by the report", async () => {
    const r = await gapCheckAt(ask(base, { only_tests: ["add > adds", "add > zero"] }), opts);
    expect(r).toMatchObject({ shape: "gapCheck", ran: true, passed: false, repo: "demo", head: base, test_file: "calc.test.ts", exit_code: 1, signalled: false });
    if (!r.ran) throw new Error(r.why);
    expect(r.names["add > adds"]).toMatchObject({ result: "fail", error: expect.any(String) });
    expect(r.names["add > zero"]).toEqual({ result: "pass" });
    expect(r.out).toContain("add > adds");
    expect(await gapCheckAt(ask(green), opts)).toMatchObject({ ran: true, passed: true, head: green, names: { "add > adds": { result: "pass" } }, exit_code: 0 });
  });

  it("[MUST-FAIL] a name the report does not hold is absent, and does not pass", async () => {
    expect(await gapCheckAt(ask(green, { only_tests: ["add > adds", "add > gone"] }), opts))
      .toMatchObject({ ran: true, passed: false, names: { "add > adds": { result: "pass" }, "add > gone": { result: "absent" } } });
  });

  it("[MUST-FAIL] with no names, the file's own exit decides", async () => {
    expect(await gapCheckAt(ask(base, { only_tests: [] }), opts)).toMatchObject({ ran: true, passed: false, names: {}, exit_code: 1 });
    expect(await gapCheckAt(ask(green, { only_tests: [] }), opts)).toMatchObject({ ran: true, passed: true, names: {}, exit_code: 0 });
  });

  it("[MUST-FAIL] runs nothing it cannot place: a commit not on origin's branch, a test file not in its tree, a repository with no copy, a malformed ask", async () => {
    const off = commit({ "calc.ts": fixed + "// not pushed\n" }, "never pushed", false);
    g(SEED, "push", "-q", "origin", `${off}:refs/heads/other`);
    expect(await gapCheckAt(ask(off), opts)).toMatchObject({ ran: false, passed: false, why: `${off} is not on origin's dev` });
    expect(await gapCheckAt(ask(green, { test_file: "nope.test.ts" }), opts)).toMatchObject({ ran: false, passed: false, why: expect.stringContaining("is not in the tree") });
    expect(await gapCheckAt(ask(green, { repo: "elsewhere" }), opts)).toMatchObject({ ran: false, passed: false, why: "elsewhere has no origin on this node" });
    for (const bad of [{ ref: "dev" }, { ref: green.slice(0, 12) }, { repo: "../demo" }, { branch: "../dev" }, { test_file: "../calc.test.ts" },
      { test_file: "/etc/passwd" }, { test_file: "-x" }, { test_file: "./calc.test.ts/" }, { only_tests: "add > adds" }, { only_tests: [1] }]) {
      expect(await gapCheckAt(ask(green, bad), opts)).toMatchObject({ ran: false, passed: false });
    }
    // a path that leaves the tree is refused by its form, even where it names a file that is there: the tree is written
    // out to a directory named gap, so ../gap/ comes back into it
    expect(await gapCheckAt(ask(green, { test_file: "../gap/calc.test.ts" }), opts)).toMatchObject({ ran: false, passed: false, why: "test_file must be a path inside the repository" });
  });

  it("[MUST-FAIL] is served to a caller by its shape, works in no clone, and is not offered to the walk", async () => {
    expect(resolvers.has("gap_check")).toBe(true);
    expect(wrapsClone("gap_check")).toBe(false);
    expect("gap_check" in SHAPE_INPUTS || "gap_check" in SHAPE_ANSWERS).toBe(false);
    // https only outside a test: the local origin is refused by its transport, and so runs nothing
    const r = await resolvers.get("gap_check")!({ body: { impulse: { pointer: { type: "gap_check", ...(ask(green) as object) } } } } as never);
    expect(r).toMatchObject({ ran: false, passed: false, why: "fetching dev from origin failed" });
  });
});
