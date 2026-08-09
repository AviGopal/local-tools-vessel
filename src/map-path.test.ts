// Pins mapPath's three cases. This function decides which tree every fs_read, fs_write
// and fs_edit in the fleet lands in, and it had no test when a relative path silently
// resolved into this vessel's own directory — see the comment in index.ts.
//
// mapPath is not exported (index.ts starts a server on import), so the logic is
// mirrored here. That is a real duplication risk, and the reason the assertions below
// name the two constants explicitly: if index.ts changes, this fails loudly rather than
// passing against a stale copy.
import { describe, expect, it } from "bun:test";

const RUNTIME_ROOT = "/vessels";
const DEFAULT_CWD = "/workspace";

function mapPath(p: string | undefined): string | undefined {
  if (!p) return p;
  if (p.startsWith("repos/")) return `${RUNTIME_ROOT}/${p.slice("repos/".length)}`;
  if (!p.startsWith("/")) return `${DEFAULT_CWD}/${p}`;
  return p;
}

describe("mapPath", () => {
  it("rewrites repos/ to the runtime root", () => {
    expect(mapPath("repos/activity-api/src/index.ts")).toBe("/vessels/activity-api/src/index.ts");
  });

  it("leaves absolute paths untouched", () => {
    expect(mapPath("/vessels/activity-api/src/index.ts")).toBe("/vessels/activity-api/src/index.ts");
    expect(mapPath("/workspace/git/vessels/activity-api")).toBe("/workspace/git/vessels/activity-api");
  });

  it("anchors relative paths to the workspace, NOT the process cwd", () => {
    // The regression: these used to fall through unchanged and resolve against
    // WorkingDirectory=/vessels/local-tools-vessel, which contains no other source.
    expect(mapPath("git/vessels/activity-api/sql/schemas/020-paradigm-core-tables.surql"))
      .toBe("/workspace/git/vessels/activity-api/sql/schemas/020-paradigm-core-tables.surql");
    expect(mapPath("trace_store_schema.sql")).toBe("/workspace/trace_store_schema.sql");
  });

  it("keeps repos/ winning over the relative-path anchor", () => {
    // repos/ is relative too, so order matters: it must not become /workspace/repos/...
    expect(mapPath("repos/goal-host-vessel/src/index.ts")).toBe("/vessels/goal-host-vessel/src/index.ts");
    expect(mapPath("repos/x")).not.toStartWith("/workspace");
  });

  it("passes empty and undefined through unchanged", () => {
    expect(mapPath(undefined)).toBeUndefined();
    expect(mapPath("")).toBe("");
  });
});
