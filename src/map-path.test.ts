// Pins mapPath's path decisions. This vessel's tools run with
// WorkingDirectory=/vessels/local-tools-vessel, so an unanchored relative path
// resolves against a directory holding no vessel source — which is how
// code-investigation goals came to search the wrong tree and confabulate
// filenames.
//
// THIS TEST USED TO RE-DECLARE mapPath INSTEAD OF IMPORTING IT (2026-08-09).
// mapPath was not exported, so I copied its body here. The suite then tested a
// COPY: the real function could be broken arbitrarily and all five tests still
// passed. PROVEN — an index.ts whose repos/ branch returned its argument
// unchanged left this suite fully green, which is exactly how a mitosis gate
// came to report "0 introduced" on a genuinely broken patch.
//
// A test that re-implements its subject is worse than no test: it reports
// coverage that does not exist and stays green through any regression. mapPath
// is now exported and imported here, so breaking it breaks this file.
import { describe, expect, it } from "bun:test";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

import { mapPath } from "./index";

// The roots mapPath reads (index.ts): relative paths anchor to WORKSPACE_ROOT, repos/ paths to
// MITOSIS_RUNTIME_DIR. The pull-sync gate runs this suite with WORKSPACE_ROOT set to a throwaway root, so
// expectations hardcoded to /workspace failed there on every tick although mapPath was right.
const WORKSPACE = process.env.WORKSPACE_ROOT ?? "/workspace";
const RUNTIME = process.env.MITOSIS_RUNTIME_DIR ?? "/vessels";

describe("mapPath", () => {
  it("rewrites repos/ to the runtime root", () => {
    expect(mapPath("repos/goal-host-vessel/src/index.ts")).toBe(
      `${RUNTIME}/goal-host-vessel/src/index.ts`,
    );
  });

  // An absolute path is confined like any other: this vessel holds the fleet's credentials, so a path outside every
  // tool root is refused, never passed through (index.ts). Inside a root (the temp dir is always one) it comes back as
  // its resolved location.
  it("keeps an absolute path inside a tool root, resolved", () => {
    const inside = `${tmpdir()}/map-path-case/src/index.ts`;
    expect(mapPath(inside)).toBe(`${realpathSync(tmpdir())}/map-path-case/src/index.ts`);
  });

  it("[MUST-FAIL] refuses an absolute path outside every tool root: the fleet's secrets are never a path", () => {
    expect(() => mapPath("/etc/substrate/env")).toThrow();
    expect(() => mapPath("/proc/self/environ")).toThrow();
  });

  it("anchors relative paths to the workspace, NOT the process cwd", () => {
    // The whole point: without this, `find . -name '*.ts'` searched
    // /vessels/local-tools-vessel and found no vessel source.
    // The path lies in a workspace data dir (tool-roots.ts WORKSPACE_DATA_DIRS): /workspace itself is not a root,
    // since it holds .substrate-secrets, so a path elsewhere under it is refused, and asserting one here failed
    // wherever WORKSPACE_ROOT is the real workspace.
    expect(mapPath("proposals/map-path-case.md")).toBe(`${WORKSPACE}/proposals/map-path-case.md`);
    expect(mapPath("proposals/map-path-case.md")!.startsWith(`${process.cwd()}/`)).toBe(WORKSPACE === process.cwd());
  });

  it("[MUST-FAIL] refuses a relative path that climbs out of the workspace to the fleet's secrets", () => {
    expect(() => mapPath("../../../../../../../../etc/substrate/env")).toThrow();
  });

  it("keeps repos/ winning over the relative-path anchor", () => {
    // Both branches match a bare "repos/..." string; the repos/ rewrite must run
    // first or every vessel path lands under /workspace/repos/... which is dead.
    expect(mapPath("repos/concept-db/sql/001.surql")).toBe(
      `${RUNTIME}/concept-db/sql/001.surql`,
    );
  });

  it("passes empty and undefined through unchanged", () => {
    expect(mapPath(undefined)).toBeUndefined();
    expect(mapPath("")).toBe("");
  });
});
