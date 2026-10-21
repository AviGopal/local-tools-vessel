/**
 * OBSERVE-ONLY LINES PER sh() CALL: `[sh-instrument] {"phase":"start",...}` at spawn and
 * `[sh-instrument] {"phase":"end",...}` on return or throw, paired by `call_id`.
 *
 * Why it exists (2026-10-20): feature_compose's main verify asks sh() for a 720 s
 * bound, yet every single-verify compose measured got EMPTY stdout back 300-359 s
 * after its request, while a bare `sleep 320; echo done` with the same bound
 * answers fine at 320 s. Source and behaviour disagree, so before anything is
 * changed this records, for every real call, the bound sh() actually applied, how
 * long the test-slot wait took, when bash exited versus when its pipes reached EOF
 * (an orphan that inherited stdout keeps the read open after bash is gone), how the
 * call ended, and what it left running.
 *
 * It must never change what sh() does or returns: every entry point swallows its
 * own errors, and a probe that cannot open is a no-op. It never logs command text,
 * stdout/stderr content, env, or /proc/<pid>/cmdline|environ: only a hash of the
 * command, the basename of its first non-assignment word, byte counts, and for
 * survivors pid/comm/pgid/age read from /proc/<pid>/stat and /proc/<pid>/comm.
 */
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";

export type EndKind = "normal_exit" | "group_kill" | "signal_abort" | "killed_unknown" | "error";

export interface ShProbeInput {
  cmd: string;
  requestedTimeoutSec: number | undefined;
  effectiveTimeoutSec: number;
  testClass: boolean;
  executionId?: string;
  callerTag?: string;
}

export interface ShProbe {
  slotAcquired(): void;
  spawned(pid: number): void;
  exited(): void;
  eof(): void;
  done(outcome: { result?: { stdout: string; stderr: string; exit_code: number }; threw: boolean; aborted: boolean; signal: string | null }): void;
}

const NOOP_PROBE: ShProbe = { slotAcquired() {}, spawned() {}, exited() {}, eof() {}, done() {} };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/;
const safeId = (v: unknown): string | null => (typeof v === "string" && SAFE_ID.test(v) ? v : null);

/** Basename of the first word that is not a NAME=value assignment, charset-limited. Never other text. */
export function argv0Base(cmd: string): string {
  for (const raw of cmd.trim().split(/\s+/)) {
    const w = raw.replace(/^['"]+|['"]+$/g, "");
    if (!w || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
    const base = w.slice(w.lastIndexOf("/") + 1);
    return /^[A-Za-z0-9._+-]{1,40}$/.test(base) ? base : "?";
  }
  return "?";
}

/** The only form of a command the journal gets: hash + first-word basename, never its text.
 *  Used by this instrument and by the shell handlers' own request/refusal log lines. */
export function cmdSha12(cmd: string): string {
  return createHash("sha256").update(cmd).digest("hex").slice(0, 12);
}
export function cmdRef(cmd: string): string {
  return `cmd_sha12=${cmdSha12(cmd)} argv0_base=${argv0Base(cmd)}`;
}

interface ProcStat { pid: number; ppid: number; pgid: number; start: number }

function readStat(pid: number): ProcStat | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, "utf8");
    const f = s.slice(s.lastIndexOf(")") + 2).split(" ");
    // After "(comm) ": f[0]=state f[1]=ppid f[2]=pgrp ... f[19]=starttime (field 22).
    return { pid, ppid: Number(f[1]), pgid: Number(f[2]), start: Number(f[19]) };
  } catch { return null; }
}

function allStats(): ProcStat[] {
  const out: ProcStat[] = [];
  let names: string[] = [];
  try { names = readdirSync("/proc"); } catch { return out; }
  for (const d of names) {
    if (!/^\d+$/.test(d)) continue;
    const st = readStat(Number(d));
    if (st) out.push(st);
  }
  return out;
}

function comm(pid: number): string {
  try { return readFileSync(`/proc/${pid}/comm`, "utf8").trim().replace(/[^A-Za-z0-9._+:-]/g, "?").slice(0, 16); } catch { return "?"; }
}

// starttime is in clock ticks; USER_HZ is 100 on every Linux ABI this fleet runs on.
const CLK_TCK = 100;
function uptimeSec(): number {
  try { return Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]); } catch { return NaN; }
}

/**
 * Tracks what bash started, so survivors can be counted after bash is gone (its
 * children are reparented then, and the ppid link to them is lost).
 *
 * groupBounded's script runs under `set -m`, so bash's FIRST child is the
 * `( cmd ) &` job, a process-group leader (pgid = its pid), and its SECOND is the
 * watchdog subshell, also its own group. /proc/<pid>/task/<pid>/children lists
 * children in creation order; the job/watchdog split rests on that order. The
 * watchdog group is reported apart (`watchdog_left`): on a normal exit bash signals
 * the watchdog's whole group, its `sleep <timeout>` included, so this should read 0;
 * a nonzero count is a watchdog that outlived its call, not a job survivor.
 *
 * Sampling at 10 ms, 100 ms, 1 s, then every 30 s also records the job's
 * descendants (pid + starttime) while their parents still link them, which
 * catches a descendant that moved itself into another process group. A
 * descendant that changes group and is reparented between two samples is
 * missed. A call whose bash exits before the first sample is reported
 * `survivors_tracked: false`, not as a measured 0.
 */
class Tracker {
  private bashPid = 0;
  private jobPgid: number | null = null;
  private watchdogPgid: number | null = null;
  private seen = new Map<number, number>(); // pid -> starttime
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  start(pid: number): void {
    this.bashPid = pid;
    const delays = [10, 90, 900];
    const next = () => {
      if (this.stopped) return;
      const d = delays.shift() ?? 30_000;
      this.timer = setTimeout(() => { try { this.sample(); } catch { /* observe-only */ } next(); }, d);
      (this.timer as { unref?: () => void }).unref?.();
    };
    next();
  }

  private sample(): void {
    if (this.jobPgid === null) {
      let kids: number[] = [];
      try { kids = readFileSync(`/proc/${this.bashPid}/task/${this.bashPid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number); } catch { return; }
      if (kids.length === 0) return;
      const job = readStat(kids[0]!);
      if (!job) return;
      this.jobPgid = job.pgid;
      this.seen.set(job.pid, job.start);
      if (kids[1] !== undefined) this.watchdogPgid = readStat(kids[1])?.pgid ?? null;
    }
    // Descendants of every job process seen so far (one /proc pass).
    const stats = allStats();
    const kidsOf = new Map<number, ProcStat[]>();
    for (const st of stats) { const l = kidsOf.get(st.ppid) ?? []; l.push(st); kidsOf.set(st.ppid, l); }
    const stack = [...this.seen.keys()];
    while (stack.length) {
      for (const c of kidsOf.get(stack.pop()!) ?? []) {
        if (c.pgid === this.watchdogPgid || this.seen.has(c.pid)) continue;
        this.seen.set(c.pid, c.start);
        stack.push(c.pid);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  survivors(): { tracked: boolean; count: number; procs: Array<{ pid: number; comm: string; pgid: number; age_s: number }>; watchdogLeft: number } {
    if (this.jobPgid === null) return { tracked: false, count: 0, procs: [], watchdogLeft: 0 };
    const up = uptimeSec();
    const procs: Array<{ pid: number; comm: string; pgid: number; age_s: number }> = [];
    let count = 0;
    let watchdogLeft = 0;
    for (const st of allStats()) {
      if (st.pid === process.pid) continue;
      if (this.watchdogPgid !== null && st.pgid === this.watchdogPgid) { watchdogLeft++; continue; }
      const inJob = st.pgid === this.jobPgid || this.seen.get(st.pid) === st.start;
      if (!inJob) continue;
      count++;
      if (procs.length < 10) procs.push({ pid: st.pid, comm: comm(st.pid), pgid: st.pgid, age_s: Math.round((up - st.start / CLK_TCK) * 10) / 10 });
    }
    return { tracked: true, count, procs, watchdogLeft };
  }
}

/**
 * end_kind is inferred, and the inference is only as strong as this:
 * - signal_abort: the AbortSignal backstop (bound + 5 s) fired; Bun then kills bash itself.
 * - error: spawn or the reads threw.
 * - group_kill: the watchdog `__killtree`s the job with SIGKILL, so `wait $__cpid` yields
 *   128+9 and the wrapper exits 137. It is called group_kill only when that 137 arrives
 *   at or after the bound (250 ms slack for scheduling): a 137 earlier is someone else's
 *   SIGKILL (e.g. the OOM killer), not the watchdog's.
 * - killed_unknown: bash itself died by a signal, or the exit code is 128+n without
 *   matching the watchdog's timing. It also covers a command that merely chose to
 *   `exit 13x`; that cannot be told apart from outside.
 * - normal_exit: anything else, including non-zero exits.
 */
export function inferEndKind(o: { aborted: boolean; threw: boolean; signal: string | null; exitCode: number | null; spawnToExitMs: number | null; effectiveTimeoutSec: number }): EndKind {
  if (o.aborted) return "signal_abort";
  if (o.threw) return "error";
  if (o.exitCode === 137 && o.spawnToExitMs !== null && o.spawnToExitMs >= o.effectiveTimeoutSec * 1000 - 250) return "group_kill";
  if (o.signal || (o.exitCode !== null && o.exitCode >= 128)) return "killed_unknown";
  return "normal_exit";
}

function openProbe(input: ShProbeInput): ShProbe {
  const t0 = Date.now();
  let tSlot: number | null = null;
  let tSpawn: number | null = null;
  let tExit: number | null = null;
  let tEof: number | null = null;
  const tracker = new Tracker();
  // Fields both lines carry. call_id pairs a start with its end, so a hung call reads
  // as a start with no end rather than as nothing at all.
  const ident = () => ({
    call_id: randomBytes(6).toString("hex"),
    cmd_sha12: cmdSha12(input.cmd),
    argv0_base: argv0Base(input.cmd),
    caller_tag: safeId(input.callerTag),
    execution_id: safeId(input.executionId),
  });
  let id: ReturnType<typeof ident> | null = null;
  const bounds = () => ({
    effective_timeout_sec: input.effectiveTimeoutSec,
    requested_timeout_sec: typeof input.requestedTimeoutSec === "number" && Number.isFinite(input.requestedTimeoutSec) ? input.requestedTimeoutSec : null,
    test_class: input.testClass,
    slot_wait_ms: input.testClass && tSlot !== null ? tSlot - t0 : 0,
  });
  return {
    slotAcquired() { tSlot = Date.now(); },
    spawned(pid) {
      tSpawn = Date.now();
      try { tracker.start(pid); } catch { /* observe-only */ }
      try {
        id = ident();
        shInstrument.emit(`[sh-instrument] ${JSON.stringify({ phase: "start", call_id: id.call_id, ...bounds(), cmd_sha12: id.cmd_sha12, argv0_base: id.argv0_base, caller_tag: id.caller_tag, execution_id: id.execution_id })}`);
      } catch { /* observe-only */ }
    },
    exited() { tExit = Date.now(); },
    eof() { tEof = Date.now(); },
    done(o) {
      try {
        tracker.stop();
        const spawnToExit = tSpawn !== null && tExit !== null ? tExit - tSpawn : null;
        const exitCode = o.result ? o.result.exit_code : null;
        const s = tracker.survivors();
        const i = id ?? ident(); // no start line when spawn itself threw
        const line = {
          phase: "end",
          call_id: i.call_id,
          ...bounds(),
          spawn_to_exit_ms: spawnToExit,
          spawn_to_eof_ms: tSpawn !== null && tEof !== null ? tEof - tSpawn : null,
          end_kind: inferEndKind({ aborted: o.aborted, threw: o.threw, signal: o.signal, exitCode, spawnToExitMs: spawnToExit, effectiveTimeoutSec: input.effectiveTimeoutSec }),
          signal: o.signal ? safeId(o.signal) : null,
          exit_code: exitCode,
          stdout_bytes: o.result ? Buffer.byteLength(o.result.stdout) : null,
          stderr_bytes: o.result ? Buffer.byteLength(o.result.stderr) : null,
          cmd_sha12: i.cmd_sha12,
          argv0_base: i.argv0_base,
          caller_tag: i.caller_tag,
          execution_id: i.execution_id,
          survivors_tracked: s.tracked,
          survivors: s.count,
          survivor_procs: s.procs,
          watchdog_left: s.watchdogLeft,
        };
        shInstrument.emit(`[sh-instrument] ${JSON.stringify(line)}`);
      } catch { /* observe-only: never let the instrument reach the caller */ }
    },
  };
}

/** Test seam. `open` is the whole instrument; replacing it with () => no-op probe removes all of it. */
export const shInstrument: { open: (input: ShProbeInput) => ShProbe; emit: (line: string) => void } = {
  open: openProbe,
  emit: (line) => console.log(line),
};

/** sh()'s single entry: never throws, falls back to a no-op probe. */
export function openShProbe(input: ShProbeInput): ShProbe {
  try {
    const p = shInstrument.open(input);
    const guard = (f: (...a: any[]) => void) => (...a: any[]) => { try { f(...a); } catch { /* observe-only */ } };
    return { slotAcquired: guard(p.slotAcquired), spawned: guard(p.spawned), exited: guard(p.exited), eof: guard(p.eof), done: guard(p.done) };
  } catch { return NOOP_PROBE; }
}

export const NOOP_SH_PROBE = NOOP_PROBE;
