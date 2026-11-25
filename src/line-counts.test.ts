// A line tool's count is the file's as it left it: what code_read_lines then reads. A replace or an insert whose text
// holds several lines writes each of them, and says so in new_total_lines (and an insert in lines_added), so a drafter
// planning the next range from that count plans against the file's real length.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = mkdtempSync(join(tmpdir(), "line-counts-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const trees = join(T, "trees");
const dir = join(trees, "demo-vessel-mwabc123-1a2b3c4d", "src");
mkdirSync(dir, { recursive: true });

const call = async (tool: string, pointer: Record<string, unknown>): Promise<Record<string, unknown>> => {
  Object.assign(process.env, { WALK_TREES_DIR: trees, MITOSIS_PUSH_CLONE_DIR: join(T, "vessels") });
  const { resolvers } = await import("./index");
  return (await resolvers.get(tool)!({ body: { impulse: { pointer } } } as never)) as Record<string, unknown>;
};
const fileOf = (name: string, n: number): string => {
  const file = join(dir, name);
  writeFileSync(file, Array.from({ length: n }, (_, i) => `const l${i} = ${i};`).join("\n") + "\n");
  return file;
};
const twenty = Array.from({ length: 20 }, (_, i) => `const n${i} = ${i};`).join("\n");
const readTotal = async (path: string): Promise<unknown> => (await call("code_read_lines", { path, start_line: 1, end_line: 1 })).total_lines;

describe("a line tool's count is the file's as it left it", () => {
  it("[MUST-FAIL] a 20-line text replacing one line: new_total_lines is what code_read_lines reads after it", async () => {
    const file = fileOf("replace-many.ts", 100);
    const out = await call("code_replace_lines", { path: file, start_line: 10, end_line: 10, text: twenty });
    expect(out).toMatchObject({ shape: "codeReplaceResult", lines_removed: 1 });
    expect(out.new_total_lines).toBe(await readTotal(file));
    expect(out.new_total_lines).toBe(101 + 19);
  });

  it("[MUST-FAIL] a 20-line text inserted: new_total_lines is what code_read_lines reads, and lines_added is 20", async () => {
    const file = fileOf("insert-many.ts", 100);
    const out = await call("code_insert_after_line", { path: file, after_line: 10, text: twenty });
    expect(out).toMatchObject({ shape: "codeInsertResult", lines_added: 20 });
    expect(out.new_total_lines).toBe(await readTotal(file));
    expect(out.new_total_lines).toBe(101 + 20);
  });

  it("[GUARD] a one-line text: the counts are as before, and the bytes written are the text in place of the range", async () => {
    const file = fileOf("one.ts", 5);
    const r = await call("code_replace_lines", { path: file, start_line: 2, end_line: 3, text: "const x = 1;" });
    expect(r).toMatchObject({ lines_removed: 2, new_total_lines: 5 });
    expect(r.new_total_lines).toBe(await readTotal(file));
    const i = await call("code_insert_after_line", { path: file, after_line: 0, text: "// top" });
    expect(i).toMatchObject({ lines_added: 1, new_total_lines: 6 });
    expect(readFileSync(file, "utf8")).toBe("// top\nconst l0 = 0;\nconst x = 1;\nconst l3 = 3;\nconst l4 = 4;\n");
  });
});
