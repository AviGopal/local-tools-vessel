/**
 * Test preload (bunfig.toml): every test run makes its temporary files in one throwaway directory, removed on exit.
 *
 * Tests that run agent shell commands in process (sh()) or through a spawned server leave what the vessel makes in
 * tmp behind them: shell-privilege's per-process homes directory, with its nobody-owned bun cache. A suite run
 * inside a live container (the pull-sync gate) then added those to the node's /tmp every time. Set here, before any
 * import, TMPDIR holds for the whole run, and so do tool roots, which read it. 0755, so the unprivileged shell user
 * can reach a HOME inside it, as it can under /tmp. It is removed by a preload-level afterAll, which bun runs once
 * after the whole run (bun test does not emit process "exit").
 */
import { afterAll } from "bun:test"
import { chmodSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "local-tools-test-"))
chmodSync(dir, 0o755)
process.env.TMPDIR = dir
afterAll(() => rmSync(dir, { recursive: true, force: true }))
