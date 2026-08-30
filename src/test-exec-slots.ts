/**
 * A CROSS-PROCESS capacity bound for CPU-heavy test/typecheck commands run
 * through `sh()`.
 *
 * `compose-slots.ts` in development-vessel already bounds how many
 * `gap-compose.service` composes run at once (default cap 2), but it only
 * sees the compose lane. Any caller anywhere in the fleet can independently
 * ask this vessel's `sh()` to run `bun test` or `bun run typecheck` — a
 * verify step, an ad-hoc probe, a walk-dispatched check — and none of that
 * traffic goes through compose-slots at all. Measured 2026-08-30: 10+
 * concurrent `timeout 240 bun test` invocations under this vessel's cgroup
 * at once, continuously replacing each other, while the compose lane's own
 * slot count stayed at 1 of 2 — the compose cap was working correctly and
 * bounding a population that was never the dominant one.
 *
 * Same mechanism as compose-slots.ts, reused rather than reinvented: a
 * directory of numbered marker files, claimed with O_EXCL so the filesystem
 * (not an in-process lock) arbitrates simultaneous arrivals, reaped by
 * mtime or dead pid so a crashed holder cannot wedge capacity forever.
 *
 * FAILS OPEN, same reasoning as compose-slots.ts: a cap that cannot see the
 * filesystem must slow the fleet, never make it unable to verify itself.
 * `sh()`'s own caller (acquireTestSlotOrWait) also fails open after a bounded
 * wait — a command that can't get a slot in time still runs, just later,
 * rather than being refused outright.
 */

import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";

// Read at CALL time, not captured as a module-level constant. A frozen
// `const SLOT_DIR = process.env[...]` binds to whatever value existed at
// import time — before any test's beforeEach can set it — which is exactly
// the bug class fixed elsewhere in the fleet today (substrate-gap.ts's
// workspaceRoot): every test in this module's own suite silently operated on
// the same real directory regardless of the per-test override it thought it
// was setting, because the constant had already latched its value at import.
function slotDir(): string {
  return process.env["TEST_EXEC_SLOT_DIR"] ?? "/workspace/test-exec-slots";
}

/**
 * sh()'s own MAX_TIMEOUT_SEC is 900s (15 min) — the longest a single command
 * it runs may legally take. Staleness must exceed that with margin, same as
 * compose-slots.ts's ceiling-vs-staleness gap, so a slot is never reaped out
 * from under a command that is still legally running. Also read at call time
 * — see slotDir() above for why.
 */
function slotStaleMs(): number {
  return Number(process.env["TEST_EXEC_SLOT_STALE_MS"] ?? 20 * 60_000);
}

function capFromEnv(): number {
  // Same reasoning as compose-slots.ts's capFromEnv: an invalid value must
  // fall back to the default, never to "unlimited".
  const raw = Number(process.env["TEST_EXEC_MAX_CONCURRENT"] ?? 2);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2;
}

/**
 * Recognize the class of command this governor exists to bound: full test
 * runs and typechecks, the CPU-heavy multi-second-to-minutes commands that
 * caused the measured saturation. Deliberately narrow — gating every shell
 * command (git status, ls, cat) behind a cap of 2 would throttle the
 * vessel's ordinary, cheap work for no reason; only the expensive class
 * needs bounding.
 */
export function isTestClassCommand(cmd: string): boolean {
  return /\bbun\s+test\b|\bbun\s+run\s+typecheck\b|\btsc\b[^\n]*--noEmit|\bnpm\s+(?:test|run\s+typecheck)\b/.test(
    cmd,
  );
}

async function holderAlive(path: string): Promise<boolean> {
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    const pid = typeof raw.pid === "number" ? raw.pid : NaN;
    if (!Number.isFinite(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  } catch {
    return true;
  }
}

async function countLive(now: number, dir: string, staleMs: number): Promise<number> {
  let live = 0;
  const names = await readdir(dir);
  for (const name of names) {
    if (!name.endsWith(".slot")) continue;
    const path = `${dir}/${name}`;
    try {
      const st = await stat(path);
      if (now - st.mtimeMs > staleMs) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (!(await holderAlive(path))) {
        await unlink(path).catch(() => {});
        continue;
      }
      live++;
    } catch {
      // Vanished mid-scan — a released slot, not a live one.
    }
  }
  return live;
}

export interface TestExecSlot {
  readonly granted: boolean;
  readonly observed: number;
  release(): Promise<void>;
}

/** Try once to take a slot. Non-blocking — callers that want to wait poll this. */
export async function acquireTestSlot(label: string): Promise<TestExecSlot> {
  const cap = capFromEnv();
  const dir = slotDir();
  const staleMs = slotStaleMs();
  let path: string | null = null;
  try {
    await mkdir(dir, { recursive: true });
    const live = await countLive(Date.now(), dir, staleMs);
    if (live >= cap) {
      return { granted: false, observed: live, release: async () => {} };
    }
    for (let i = 0; i < cap; i++) {
      const candidate = `${dir}/slot-${i}.slot`;
      try {
        await writeFile(candidate, JSON.stringify({ pid: process.pid, at: Date.now(), label }), { flag: "wx" });
        path = candidate;
        break;
      } catch {
        continue;
      }
    }
    if (path === null) {
      const nowLive = await countLive(Date.now(), dir, staleMs).catch(() => live);
      return { granted: false, observed: nowLive, release: async () => {} };
    }
    return {
      granted: true,
      observed: live,
      release: async () => {
        if (path) await unlink(path).catch(() => {});
      },
    };
  } catch {
    // Fail open — see the module comment.
    return {
      granted: true,
      observed: -1,
      release: async () => {
        if (path) await unlink(path).catch(() => {});
      },
    };
  }
}

/**
 * Block until a slot is free, up to a bounded wait, then run anyway.
 *
 * Waiting rather than refusing outright matches this vessel's existing
 * philosophy (see groupBounded / the sh() timeout comments): the fleet must
 * slow under load, never lose the ability to verify a fix. A caller whose
 * own budget is large (feature-compose's verify step budgets up to 900s for
 * a single sh() call) can afford to wait a couple of minutes for a slot; one
 * that can't will simply run alongside the others once the wait expires,
 * same as if this governor did not exist.
 */
export async function acquireTestSlotOrWait(
  label: string,
  opts: { pollMs?: number; maxWaitMs?: number } = {},
): Promise<TestExecSlot> {
  const pollMs = opts.pollMs ?? 2000;
  const maxWaitMs = opts.maxWaitMs ?? 120_000;
  const deadline = Date.now() + maxWaitMs;
  for (;;) {
    const slot = await acquireTestSlot(label);
    if (slot.granted) return slot;
    if (Date.now() >= deadline) {
      // Fail open: proceed unslotted rather than refuse the caller's command.
      return { granted: true, observed: slot.observed, release: async () => {} };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
