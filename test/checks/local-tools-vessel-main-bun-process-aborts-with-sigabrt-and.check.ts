import { describe, expect, it } from "bun:test";
import * as mod from "../../src/index";

describe("local-tools-vessel main process abort with SIGABRT", () => {
  it("MUST-FAIL: reproduce Bun crash with abort() called", async () => {
    // Call sh() with an input that would trigger the crash
    // We're asserting that the process aborts, so we expect the test to fail
    // until the underlying issue is fixed
    await expect(
      mod.sh("echo 'this should abort' && exit 1", "/tmp", 10)
    ).rejects.toThrow();
  });
});