// Pins the rule that this vessel's in-process file tools touch only paths whose
// fully resolved location lies under a tool root, and that every such tool in
// index.ts checks before its first filesystem access.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { confinePath, configuredToolRoots, NEVER_INSIDE_A_ROOT, realLocation, toolPathWithin, toolRoots } from "./tool-roots";

let base: string;
let rootA: string;
let rootB: string;
let outside: string;
let roots: string[];

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "tool-roots-")));
  rootA = join(base, "vessels");
  rootB = join(base, "workspace", "git", "super-repo");
  outside = join(base, "outside");
  for (const d of [join(rootA, "v", "src"), join(rootB, "repos"), outside]) mkdirSync(d, { recursive: true });
  writeFileSync(join(rootA, "v", "src", "index.ts"), "a");
  writeFileSync(join(rootB, "README.md"), "b");
  writeFileSync(join(outside, "secret.env"), "s");
  symlinkSync(join(outside, "secret.env"), join(rootA, "v", "src", "leak.ts"));
  symlinkSync(outside, join(rootB, "repos", "escape"));
  symlinkSync(join(rootA, "v"), join(rootB, "repos", "v-link"));
  roots = toolRoots([rootA, rootB]);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("confinePath refuses what lies outside the roots", () => {
  it("refuses the env file, /proc environ and the secrets file even with / and /workspace offered as roots", () => {
    const wide = toolRoots(["/", "/workspace", "/etc", "/proc", rootA]);
    for (const p of ["/etc/substrate/env", "/proc/self/environ", "/workspace/.substrate-secrets/x", "/workspace/.substrate-secrets"]) {
      expect(confinePath(p, wide)).toBeNull();
      expect(confinePath(p, roots)).toBeNull();
    }
  });

  it("drops any configured root that is or contains a protected location", () => {
    expect(toolRoots(["/", "/workspace", "/etc", "/etc/substrate", "/proc"])).toEqual([]);
    for (const n of NEVER_INSIDE_A_ROOT) expect(toolRoots([n])).toEqual([]);
  });

  it("refuses a ../ traversal out of a root", () => {
    expect(confinePath(join(rootA, "v", "..", "..", "outside", "secret.env"), roots)).toBeNull();
    expect(confinePath(`${rootA}/../outside/secret.env`, roots)).toBeNull();
  });

  it("refuses a symlink inside a root that points outside", () => {
    expect(confinePath(join(rootA, "v", "src", "leak.ts"), roots)).toBeNull();
    expect(confinePath(join(rootB, "repos", "escape", "secret.env"), roots)).toBeNull();
    expect(confinePath(join(rootB, "repos", "escape", "new-file.ts"), roots)).toBeNull();
  });

  it("refuses a sibling whose name merely starts with a root's name", () => {
    mkdirSync(`${rootA}-evil`, { recursive: true });
    expect(confinePath(`${rootA}-evil/x`, roots)).toBeNull();
  });

  it("refuses empty input", () => {
    expect(confinePath(undefined, roots)).toBeNull();
    expect(confinePath("", roots)).toBeNull();
  });
});

describe("confinePath allows what lies inside the roots", () => {
  it("allows a normal file in each root", () => {
    expect(confinePath(join(rootA, "v", "src", "index.ts"), roots)).toBe(join(rootA, "v", "src", "index.ts"));
    expect(confinePath(join(rootB, "README.md"), roots)).toBe(join(rootB, "README.md"));
  });

  it("allows a new file path (fs_write) under a root, including in new directories", () => {
    expect(confinePath(join(rootA, "v", "src", "new.ts"), roots)).toBe(join(rootA, "v", "src", "new.ts"));
    expect(confinePath(join(rootB, "a", "b", "c.json"), roots)).toBe(join(rootB, "a", "b", "c.json"));
  });

  it("allows a symlink from one root into another", () => {
    expect(confinePath(join(rootB, "repos", "v-link", "src", "index.ts"), roots)).toBe(join(rootA, "v", "src", "index.ts"));
  });

  it("realLocation resolves the existing ancestor and keeps the new tail", () => {
    expect(realLocation(join(rootB, "repos", "v-link", "src", "later.ts"))).toBe(join(rootA, "v", "src", "later.ts"));
  });
});

describe("configuredToolRoots (the live configuration)", () => {
  const LIVE = {
    WORKSPACE_ROOT: "/workspace/git/super-repo",
    MITOSIS_RUNTIME_DIR: "/vessels",
    MITOSIS_PUSH_CLONE_DIR: "/workspace/git/vessels",
  };
  const live = configuredToolRoots(LIVE, "/tmp");

  it("never contains /etc, /proc or the secrets file, and none of them is reachable", () => {
    for (const r of live) for (const n of NEVER_INSIDE_A_ROOT) {
      expect(n === r || n.startsWith(r + "/")).toBe(false);
    }
    for (const p of ["/etc/substrate/env", "/proc/self/environ", "/workspace/.substrate-secrets", "/workspace/.substrate-secrets/x", "/workspace/keys/x", "/root/.bashrc"]) {
      expect(confinePath(p, live)).toBeNull();
    }
  });

  it("serves the roots callers use", () => {
    for (const p of [
      "/vessels/development-vessel/src/index.ts",
      "/workspace/git/super-repo/docs/x.md",
      "/workspace/git/vessels/activity-api/src/a.ts",
      "/workspace/git/compose/fc-1/development-vessel/src/a.ts",
      "/tmp/fc-orig-abc",
      "/workspace/proposals/g-report.json",
      "/workspace/observations/orthogonal-latest.json",
      "/workspace/patterns/trace-pattern-1.json",
    ]) expect(confinePath(p, live)).not.toBeNull();
  });

  it("an unset WORKSPACE_ROOT does not open the whole workspace", () => {
    const roots = configuredToolRoots({}, "/tmp");
    expect(roots.includes("/workspace")).toBe(false);
    expect(confinePath("/workspace/.substrate-secrets", roots)).toBeNull();
  });

  it("honours EXTRA_WORKSPACE_ROOTS but still drops a protected one", () => {
    const roots = configuredToolRoots({ ...LIVE, EXTRA_WORKSPACE_ROOTS: "/vessels/packages, /etc" }, "/tmp");
    expect(roots.includes("/etc")).toBe(false);
  });
});

describe("toolPathWithin (what each tool operates on)", () => {
  it("returns null for a path outside the roots, the mapped path inside, undefined for none", () => {
    expect(toolPathWithin("/etc/substrate/env", roots)).toBeNull();
    expect(toolPathWithin("/proc/self/environ", roots)).toBeNull();
    expect(toolPathWithin(join(rootA, "v", "src", "leak.ts"), roots)).toBeNull();
    expect(toolPathWithin(join(rootA, "v", "src", "index.ts"), roots)).toBe(join(rootA, "v", "src", "index.ts"));
    expect(toolPathWithin(undefined, roots)).toBeUndefined();
    expect(toolPathWithin("", roots)).toBeUndefined();
  });
});

// Every in-process path-taking resolver in index.ts, by handler name.
const PATH_TOOLS = [
  "fsRead", "fsWrite", "fsEdit", "codeSearch", "codeFindFunction", "codeFindImport",
  "codeInsertAfterLine", "codeReplaceLines", "codeAddImport", "codeReadLines",
];

describe("every in-process path tool confines before touching the filesystem", () => {
  const src = readFileSync(join(import.meta.dir, "index.ts"), "utf8");

  function body(name: string): string {
    const start = src.indexOf(`const ${name}: ResolverHandler`);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("\nconst ", start + 1);
    return src.slice(start, next === -1 ? undefined : next);
  }

  it("toolPath is mapPath followed by toolPathWithin over the configured roots", () => {
    expect(src).toContain("const TOOL_ROOTS = configuredToolRoots(process.env, tmpdir());");
    expect(src).toContain("const toolPath = (raw: string | undefined): string | undefined | null => toolPathWithin(mapPath(raw), TOOL_ROOTS);");
  });

  it("the handler list is complete: every handler that maps a path is listed", () => {
    const mapping = [...src.matchAll(/const (\w+): ResolverHandler[\s\S]*?(?=\nconst |\n\/\/ ──|$)/g)]
      .filter((m) => m[0].includes('str(ctx.body, "path")'))
      .map((m) => m[1]);
    expect(mapping.sort()).toEqual([...PATH_TOOLS].sort());
  });

  it("writePath confines through toolPath and refuses with OUTSIDE_ROOTS_ERROR", () => {
    const start = src.indexOf("export function writePath(");
    expect(start).toBeGreaterThan(-1);
    const w = src.slice(start, src.indexOf("\n}\n", start));
    expect(w).toContain("toolPath(rawPath)");
    expect(w).toContain("OUTSIDE_ROOTS_ERROR");
  });

  for (const name of PATH_TOOLS) {
    it(`${name} calls toolPath() before any Bun.file / Bun.write`, () => {
      const b = body(name);
      // A WRITER resolves its target through writePath (toolPath + write containment,
      // pinned below and in write-containment.test.ts); a reader through toolPath.
      const writer = b.includes("writePath(ctx, rawPath)");
      const guard = writer ? b.indexOf("writePath(ctx, rawPath)") : b.indexOf("toolPath(");
      expect(guard).toBeGreaterThan(-1);
      if (!writer) expect(b).toContain("OUTSIDE_ROOTS_ERROR");
      const firstFs = Math.min(...["Bun.file(", "Bun.write("].map((t) => b.indexOf(t)).filter((i) => i >= 0));
      expect(Number.isFinite(firstFs)).toBe(true);
      expect(guard).toBeLessThan(firstFs);
      expect(b.includes("mapPath(")).toBe(false);
    });
  }
});
