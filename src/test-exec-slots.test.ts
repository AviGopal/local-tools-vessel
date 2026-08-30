// Pins the concurrency governor added 2026-08-30 for the thermal-emergency fix:
// this vessel had no bound on how many CPU-heavy bun-test/typecheck commands
// could run at once, independent of development-vessel's own compose-lane cap.
// Uses a real temp directory (the module IS the filesystem-marker mechanism —
// re-implementing it here would test a copy, the exact defect map-path.test.ts's
// own header warns against).
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireTestSlot, acquireTestSlotOrWait, isTestClassCommand } from "./test-exec-slots";

describe("isTestClassCommand", () => {
  it("matches a bare bun test invocation", () => {
    expect(isTestClassCommand("bun test --timeout 20000")).toBe(true);
  });

  it("matches a bun test invocation wrapped in timeout/groupBounded", () => {
    expect(isTestClassCommand("timeout 240 bun test --timeout 20000")).toBe(true);
  });

  it("matches bun run typecheck", () => {
    expect(isTestClassCommand("bun install && bun run typecheck")).toBe(true);
  });

  it("matches a direct tsc --noEmit invocation", () => {
    expect(isTestClassCommand("./node_modules/.bin/tsc --noEmit -p .")).toBe(true);
  });

  it("does NOT match ordinary cheap commands", () => {
    expect(isTestClassCommand("git status --short")).toBe(false);
    expect(isTestClassCommand("cat package.json")).toBe(false);
    expect(isTestClassCommand("ls -la")).toBe(false);
  });
});

describe("test-exec-slots (cap + staleness + fail-open)", () => {
  let slotDir: string;
  const savedDir = process.env["TEST_EXEC_SLOT_DIR"];
  const savedCap = process.env["TEST_EXEC_MAX_CONCURRENT"];
  const savedStale = process.env["TEST_EXEC_SLOT_STALE_MS"];

  beforeEach(() => {
    slotDir = mkdtempSync(join(tmpdir(), "test-exec-slots-"));
    process.env["TEST_EXEC_SLOT_DIR"] = slotDir;
    process.env["TEST_EXEC_MAX_CONCURRENT"] = "2";
  });

  afterEach(() => {
    rmSync(slotDir, { recursive: true, force: true });
    if (savedDir === undefined) delete process.env["TEST_EXEC_SLOT_DIR"];
    else process.env["TEST_EXEC_SLOT_DIR"] = savedDir;
    if (savedCap === undefined) delete process.env["TEST_EXEC_MAX_CONCURRENT"];
    else process.env["TEST_EXEC_MAX_CONCURRENT"] = savedCap;
    if (savedStale === undefined) delete process.env["TEST_EXEC_SLOT_STALE_MS"];
    else process.env["TEST_EXEC_SLOT_STALE_MS"] = savedStale;
  });

  // This exact bug shipped in the first version of this file: SLOT_DIR was a
  // module-level `const` read once at import time, before this suite's own
  // beforeEach could set TEST_EXEC_SLOT_DIR — so every test silently operated
  // on whatever directory existed at import (the real production default),
  // not the fresh per-test tmpdir it looked like it was isolated to. Every
  // test below appeared to test isolation while actually sharing state.
  it("reads TEST_EXEC_SLOT_DIR fresh on every call, not once at import", async () => {
    const dirA = slotDir;
    const dirB = mkdtempSync(join(tmpdir(), "test-exec-slots-b-"));
    try {
      const a = await acquireTestSlot("a");
      expect(a.granted).toBe(true);
      expect(a.observed).toBe(0);
      process.env["TEST_EXEC_SLOT_DIR"] = dirB;
      // If SLOT_DIR were frozen at import time, this would see dirA's slot-0
      // (observed 1) instead of a genuinely empty dirB (observed 0).
      const b = await acquireTestSlot("b");
      expect(b.granted).toBe(true);
      expect(b.observed).toBe(0);
      await a.release();
      await b.release();
    } finally {
      rmSync(dirB, { recursive: true, force: true });
      process.env["TEST_EXEC_SLOT_DIR"] = dirA;
    }
  });

  it("grants up to the cap, then refuses the next request", async () => {
    const a = await acquireTestSlot("a");
    const b = await acquireTestSlot("b");
    const c = await acquireTestSlot("c");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    expect(c.granted).toBe(false);
    await a.release();
    await b.release();
  });

  it("frees a slot on release, admitting the next request", async () => {
    const a = await acquireTestSlot("a");
    const b = await acquireTestSlot("b");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    await a.release();
    const c = await acquireTestSlot("c");
    expect(c.granted).toBe(true);
    await b.release();
    await c.release();
  });

  it("reaps a stale slot (mtime past SLOT_STALE_MS) even if the holder pid is alive", async () => {
    process.env["TEST_EXEC_SLOT_STALE_MS"] = "10";
    const a = await acquireTestSlot("a");
    expect(a.granted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    // A fresh acquire call must reap the now-stale slot-0 and succeed, not refuse.
    const b = await acquireTestSlot("b");
    expect(b.granted).toBe(true);
    await b.release();
  });

  it("reaps a slot whose holder pid is dead, immediately, regardless of staleness window", async () => {
    process.env["TEST_EXEC_SLOT_STALE_MS"] = "600000";
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(slotDir, { recursive: true });
    // A pid guaranteed dead: pid 1 in THIS process's own pid namespace is real,
    // so use an implausibly large one instead — process.kill on it throws ESRCH.
    await writeFile(join(slotDir, "slot-0.slot"), JSON.stringify({ pid: 999_999_999, at: Date.now() }), {
      flag: "wx",
    });
    const a = await acquireTestSlot("a");
    expect(a.granted).toBe(true);
    await a.release();
  });

  it("acquireTestSlotOrWait grants immediately when capacity is free", async () => {
    const a = await acquireTestSlotOrWait("a", { maxWaitMs: 1000 });
    expect(a.granted).toBe(true);
    await a.release();
  });

  it("acquireTestSlotOrWait waits for a slot to free, then grants it", async () => {
    const a = await acquireTestSlot("a");
    const b = await acquireTestSlot("b");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    setTimeout(() => void a.release(), 50);
    const c = await acquireTestSlotOrWait("c", { pollMs: 10, maxWaitMs: 2000 });
    expect(c.granted).toBe(true);
    await b.release();
    await c.release();
  });

  it("acquireTestSlotOrWait fails open after maxWaitMs if capacity never frees", async () => {
    const a = await acquireTestSlot("a");
    const b = await acquireTestSlot("b");
    expect(a.granted).toBe(true);
    expect(b.granted).toBe(true);
    const start = Date.now();
    const c = await acquireTestSlotOrWait("c", { pollMs: 10, maxWaitMs: 60 });
    expect(c.granted).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
    await a.release();
    await b.release();
  });
});
