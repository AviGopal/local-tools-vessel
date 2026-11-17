// An ok edit names the file as it left it: `after`, the sha256 of the bytes on disk after the call, on each of the three
// ok answers (applied, a normalized match, already in the file). A different edit of the same file, a revert included,
// answers a different `after`; one that leaves the same bytes answers the same. Errors carry none.
import { afterAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = mkdtempSync(join(tmpdir(), "edit-after-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const trees = join(T, "trees");
const dir = join(trees, "demo-vessel-mwabc123-1a2b3c4d", "src");
mkdirSync(dir, { recursive: true });
const onDisk = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const edit = async (path: string, old_string: string, new_string: string): Promise<Record<string, unknown>> => {
  Object.assign(process.env, { WALK_TREES_DIR: trees, MITOSIS_PUSH_CLONE_DIR: join(T, "vessels") });
  const { resolvers } = await import("./index");
  return (await resolvers.get("fs_edit")!({ body: { impulse: { pointer: { path, old_string, new_string } } } } as never)) as Record<string, unknown>;
};

describe("an ok edit names the file as it left it", () => {
  it("[MUST-FAIL] an applied edit carries after: the sha256 of the file's bytes on disk after it", async () => {
    const file = join(dir, "applied.ts");
    writeFileSync(file, "export const limit = 10;\nexport const name = \"a\";\n");
    const out = await edit(file, "limit = 10", "limit = 20");
    expect(out).toMatchObject({ shape: "fileEditResult", ok: true });
    expect(out.after).toBe(onDisk(file));
  });

  it("[MUST-FAIL] a normalized match carries after too", async () => {
    const file = join(dir, "normalized.ts");
    writeFileSync(file, "// a range — one to ten\nexport const x = 1;\n");
    const out = await edit(file, "// a range - one to ten", "// a range from one to ten");
    expect(out).toMatchObject({ ok: true, normalized_match: true });
    expect(out.after).toBe(onDisk(file));
  });

  it("[MUST-FAIL] an edit already in the file carries after: the bytes as found, the same as the edit that made them", async () => {
    const file = join(dir, "already.ts");
    writeFileSync(file, "export const mode = \"old\";\n");
    const first = await edit(file, "\"old\"", "\"new\"");
    const again = await edit(file, "\"old\"", "\"new\"");
    expect(again).toMatchObject({ ok: true, applied: false });
    expect(again.after).toBe(onDisk(file));
    expect(again.after).toBe(first.after);
  });

  it("[MUST-FAIL] a revert (the exact inverse of an earlier edit) answers a different after from that edit: the original bytes", async () => {
    const file = join(dir, "revert.ts");
    const original = "export const retries = 3;\nexport const backoff = 100;\n";
    writeFileSync(file, original);
    const before = onDisk(file);
    const forward = await edit(file, "retries = 3;\n", "retries = 5;\n");
    const back = await edit(file, "retries = 5;\n", "retries = 3;\n");
    expect([forward.ok, back.ok]).toEqual([true, true]);
    expect(back.after).not.toBe(forward.after);
    expect(back.after).toBe(before);
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("[MUST-FAIL] A to B to A to B: the fourth edit leaves the bytes the second did, so it answers the same after; the third does not", async () => {
    const file = join(dir, "cycle.ts");
    writeFileSync(file, "export const flag = false;\n");
    const fwd = () => edit(file, "flag = false;", "flag = true;");
    const back = () => edit(file, "flag = true;", "flag = false;");
    const [e1, e2, e3, e4] = [await fwd(), await back(), await fwd(), await back()];
    expect([e1.after, e2.after, e3.after, e4.after].every((x) => typeof x === "string")).toBe(true);
    expect(e3.after).toBe(e1.after);
    expect(e4.after).toBe(e2.after);
    expect(e2.after).not.toBe(e1.after);
  });

  it("[MUST-FAIL] the fingerprint is the written file's bytes, not the edit's new_string: two edits writing the same new_string into different files differ", async () => {
    const f1 = join(dir, "same-new-1.ts"), f2 = join(dir, "same-new-2.ts");
    writeFileSync(f1, "x = 1;\nheader one\n");
    writeFileSync(f2, "x = 1;\nheader two\n");
    const one = await edit(f1, "x = 1;", "x = 2;");
    const two = await edit(f2, "x = 1;", "x = 2;");
    expect(one.after).toBe(onDisk(f1));
    expect(two.after).toBe(onDisk(f2));
    expect(one.after).not.toBe(two.after);
  });

  it("[MUST-FAIL] two different edits of one file answer different afters; the rest of each answer is the same", async () => {
    const file = join(dir, "two.ts");
    writeFileSync(file, "a = 1;\nb = 2;\n");
    const one = await edit(file, "a = 1;", "a = 10;");
    const two = await edit(file, "b = 2;", "b = 20;");
    const { after: a1, ...rest1 } = one;
    const { after: a2, ...rest2 } = two;
    expect(a1).not.toBe(a2);
    expect(rest1).toEqual(rest2);
  });

  it("an edit that is not made carries no after (a guard)", async () => {
    const file = join(dir, "missed.ts");
    writeFileSync(file, "const z = 0;\n");
    expect("after" in (await edit(file, "zzzz qqqq wwww", "x"))).toBe(false);
    expect("after" in (await edit(file, "const z = 0;", "const z = 0;"))).toBe(false);
  });
});
