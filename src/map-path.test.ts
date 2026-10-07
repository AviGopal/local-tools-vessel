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

  it("leaves absolute paths untouched", () => {
    expect(mapPath("/vessels/analysis-vessel/src/index.ts")).toBe(
      "/vessels/analysis-vessel/src/index.ts",
    );
  });

  it("anchors relative paths to the workspace, NOT the process cwd", () => {
    // The whole point: without this, `find . -name '*.ts'` searched
    // /vessels/local-tools-vessel and found no vessel source.
    expect(mapPath("scripts/substrate/vessels.inventory.json")).toBe(
      `${WORKSPACE}/scripts/substrate/vessels.inventory.json`,
    );
    expect(mapPath("scripts/substrate/vessels.inventory.json")!.startsWith(`${process.cwd()}/`)).toBe(WORKSPACE === process.cwd());
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
