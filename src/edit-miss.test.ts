// A missed edit answers with the file's own lines over the span its anchor claims, first, within what the walk keeps of
// a refusal (its first 1000 characters).
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = mkdtempSync(join(tmpdir(), "edit-miss-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const trees = join(T, "trees");
const dir = join(trees, "demo-vessel-mwabc123-1a2b3c4d", "src");
mkdirSync(dir, { recursive: true });
const file = join(dir, "index.ts");
const body = Array.from({ length: 120 }, (_, i) => `  const value${i} = compute(${i}, "item-${i}"); // line ${i + 1}`).join("\n") + "\n";
writeFileSync(file, body);

describe("a missed edit", () => {
  it("[MUST-FAIL] leads with the file's real lines over the anchor's span, verbatim, inside the walk's 1000-character cut", async () => {
    Object.assign(process.env, { WALK_TREES_DIR: trees, MITOSIS_PUSH_CLONE_DIR: join(T, "vessels") });
    const { resolvers } = await import("./index");
    const edit = resolvers.get("fs_edit")!;
    // the first line is real; the two after it are invented (the live case)
    const old_string = `  const value40 = compute(40, "item-40"); // line 41\n  const invented = true;\n  return invented;`;
    const out = (await edit({ body: { impulse: { pointer: { path: file, old_string, new_string: "x" } } } } as never)) as Record<string, unknown>;
    expect(Object.keys(out)[0]).toBe("current");
    const current = String(out.current);
    // the real lines from two before the match through the anchor's span and two after
    for (const n of [39, 40, 41, 42, 43, 44, 45]) expect(current).toContain(`// line ${n}`);
    expect(body.includes(current)).toBe(true); // verbatim: a substring of the file as it is
    expect(JSON.stringify(out).slice(0, 1000)).toContain(JSON.stringify(current).slice(1, -1));
    expect(readFileSync(file, "utf8")).toBe(body); // nothing written
  });

  it("a long span is cut to what fits the walk's cut, from the match on (a guard)", async () => {
    const { resolvers } = await import("./index");
    const long = Array.from({ length: 40 }, (_, i) => `  const value${10 + i} = compute(${10 + i}, "item-${10 + i}"); // line ${11 + i}`).join("\n").replace("// line 50", "// invented");
    const out = (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path: file, old_string: long, new_string: "x" } } } } as never)) as Record<string, unknown>;
    expect(JSON.stringify(out.current).length).toBeLessThanOrEqual(800);
    expect(String(out.current)).toContain("// line 11");
    expect(JSON.stringify(out).slice(0, 1000)).toContain("// line 11");
  });

  it("an anchor resembling nothing still says so, and offers no lines (a guard)", async () => {
    const { resolvers } = await import("./index");
    const out = (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path: file, old_string: "zzzz qqqq wwww", new_string: "x" } } } } as never)) as Record<string, unknown>;
    expect("current" in out).toBe(false);
    expect(String(out.error)).toContain("NOTHING resembling your anchor");
  });
});
