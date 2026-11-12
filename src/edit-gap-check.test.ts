// On a clone made for a gap, an edit of the gap's own check is refused at the edit, naming where the fix belongs; on a
// clone made for anything else, tests are edited as before. And an edit asked again after it ended ok is said to be
// done, not "not found".
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isGapCheckFile } from "./git-land";

const T = mkdtempSync(join(tmpdir(), "edit-gap-check-test-"));
chmodSync(T, 0o755);
const trees = join(T, "trees");
const clone = join(trees, "demo-vessel-mwabc123-1a2b3c4d");
mkdirSync(join(clone, ".git"), { recursive: true });
mkdirSync(join(clone, "src"), { recursive: true });
const test = join(clone, "src", "calc.test.ts");
const src = join(clone, "src", "calc.ts");
const TEST = 'test("adds", () => { expect(add(1, 2)).toBe(3); });\n';
const SRC = "export const add = (a: number, b: number): number => a - b;\n";

// records, through discovery: a selection on a gap root, and one on a person's ask
const ROWS: Record<string, Record<string, unknown>> = {
  "sel-gap": { id: "sel-gap", shape: "selection", role: "walk", root: "gap-1" },
  "gap-1": { id: "gap-1", shape: "gap", role: "detector", gap_id: "G1",
    meta: { sources: ["src/calc.ts", "src/util.ts"], evidence_resolve: { input: { test_file: "src/calc.test.ts", only_tests: ["adds"] } } } },
  "sel-ask": { id: "sel-ask", shape: "selection", role: "walk", root: "ask-1" },
  "ask-1": { id: "ask-1", shape: "world_changed", role: "person", what: "fix the test" },
};
const realFetch = globalThis.fetch;
// Every test file runs in one process: what this one sets is put back as it was (or removed, if it was unset), or a
// later file's tools would ask records at an address nothing answers.
const ENV = { WALK_TREES_DIR: trees, MITOSIS_PUSH_CLONE_DIR: join(T, "vessels"), DISCOVERY_ENDPOINT: "http://discovery.test" };
const before = Object.fromEntries(Object.keys(ENV).map((k) => [k, process.env[k]]));
beforeAll(() => {
  Object.assign(process.env, ENV);
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const p = (JSON.parse(String(init?.body ?? "{}")) as { pointer?: { ids?: string[] } }).pointer ?? {};
    return Response.json((p.ids ?? []).map((id) => ROWS[id]).filter(Boolean));
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(before)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(T, { recursive: true, force: true });
});

const edit = async (path: string, old_string: string, new_string: string, selection_ref?: string) => {
  const { resolvers } = await import("./index");
  return (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path, old_string, new_string, ...(selection_ref ? { selection_ref } : {}) } } } } as never)) as Record<string, unknown>;
};

describe("the gap's check at the edit", () => {
  it("[MUST-FAIL] on a gap's clone, an edit of its test file is refused, naming where the fix belongs, and nothing is written", async () => {
    writeFileSync(test, TEST);
    const out = await edit(test, "toBe(3)", "toBe(-1)", "sel-gap");
    expect(out).toMatchObject({ refused: "gap_check" });
    expect(String(out.error)).toContain("src/calc.test.ts is the gap's check");
    expect(String(out.error)).toContain("edit the source it tests (src/calc.ts, src/util.ts)");
    expect(readFileSync(test, "utf8")).toBe(TEST);
  });

  it("[MUST-FAIL] on a clone made for a person's ask, the same test file is edited as before", async () => {
    writeFileSync(test, TEST);
    expect(await edit(test, "toBe(3)", "toBe(-1)", "sel-ask")).toMatchObject({ ok: true });
    expect(readFileSync(test, "utf8")).toContain("toBe(-1)");
  });

  it("on a gap's clone, the source the gap names is edited (a guard)", async () => {
    writeFileSync(src, SRC);
    expect(await edit(src, "a - b", "a + b", "sel-gap")).toMatchObject({ ok: true });
    expect(readFileSync(src, "utf8")).toContain("a + b");
  });

  it("the one rule: the gap's test file, what tests lean on, and what chooses how code is checked", () => {
    const gap = { test_file: "src/calc.test.ts" };
    for (const p of ["src/calc.test.ts", "test/x.ts", "src/fixtures/a.json", "tsconfig.json", "package.json"]) expect(isGapCheckFile(p, gap)).toBe(true);
    expect(isGapCheckFile("src/calc.ts", gap)).toBe(false);
  });
});

describe("an edit asked again", () => {
  it("[MUST-FAIL] after it ended ok is said to be done, not a miss, and the file is not touched", async () => {
    writeFileSync(src, SRC);
    expect(await edit(src, "a - b", "a + b")).toMatchObject({ ok: true });
    const again = await edit(src, "a - b", "a + b");
    expect(again).toMatchObject({ ok: true, applied: false });
    expect(String(again.why)).toContain("already in the file");
    expect(readFileSync(src, "utf8")).toBe(SRC.replace("a - b", "a + b"));
  });

  it("a deletion, or new text found more than once, is not taken for done (a guard)", async () => {
    writeFileSync(src, "const x = 1;\nconst y = 1;\n");
    expect((await edit(src, "const z = 2;", "")).applied).toBeUndefined();
    expect((await edit(src, "const z = 2;", " = 1;")).applied).toBeUndefined();
  });
});
