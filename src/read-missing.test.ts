// fs_read on a file that is not there answers 404 (the request's fault, as the resolver server passes a thrown 4xx
// through), naming the path it was asked for; a file that appears during the retries is read; any other read error keeps
// the {error} channel.
import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const T = mkdtempSync(join(tmpdir(), "read-missing-test-"));
chmodSync(T, 0o755);
afterAll(() => rmSync(T, { recursive: true, force: true }));
const trees = join(T, "trees");
const dir = join(trees, "demo-vessel-mwabc123-1a2b3c4d", "src");
mkdirSync(dir, { recursive: true });

const read = async (path: string): Promise<{ out?: Record<string, unknown>; err?: { message: string; status?: unknown } }> => {
  Object.assign(process.env, { WALK_TREES_DIR: trees, MITOSIS_PUSH_CLONE_DIR: join(T, "vessels") });
  const { resolvers } = await import("./index");
  try {
    return { out: (await resolvers.get("fs_read")!({ body: { impulse: { pointer: { path } } } } as never)) as Record<string, unknown> };
  } catch (e) {
    return { err: e as { message: string; status?: unknown } };
  }
};

describe("fs_read and a missing file", () => {
  it("[MUST-FAIL] a file that is not there throws 404, naming the path asked for", async () => {
    const path = join(dir, "removed.ts");
    const r = await read(path);
    expect(r.out).toBeUndefined();
    expect(r.err?.status).toBe(404);
    expect(String(r.err?.message)).toContain(path);
  });
  it("[MUST-FAIL] the message is exactly `no such file: ` and the path as the request named it, not as it was mapped", async () => {
    const abs = join(dir, "gone.ts");
    expect((await read(abs)).err?.message).toBe(`no such file: ${abs}`);
    // a repos/ path is mapped onto the runtime root; the drafter wrote "repos/…", so that is what it is told is absent
    const rel = "repos/demo-vessel-mwabc123/src/never-there.ts";
    const r = await read(rel);
    expect(r.err?.status).toBe(404);
    expect(r.err?.message).toBe(`no such file: ${rel}`);
  });
  it("a file that appears during the retries is read (a guard)", async () => {
    const path = join(dir, "late.ts");
    setTimeout(() => writeFileSync(path, "export const late = 1;\n"), 100);
    const r = await read(path);
    expect(r.err).toBeUndefined();
    expect(r.out).toMatchObject({ shape: "fileContent", content: "export const late = 1;\n" });
  });
  it("any other read error keeps the {error} channel: a directory read as a file (a guard)", async () => {
    const r = await read(dir);
    expect(r.err).toBeUndefined();
    expect(typeof r.out?.error).toBe("string");
  });
});
