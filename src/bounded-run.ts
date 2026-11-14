// One way to run a command whose output this vessel reads, so the call ends within its bound whatever the command
// starts. Killing the command alone was not enough: a process it started that kept its stdout or stderr (a server, a
// watcher, a clean filter or a hook a clone's config names, a `sleep` left running) held the read open past the bound,
// and forever if it never ended. So the command runs in its own process group; at the bound the whole group is killed
// (killTree), and once the command has ended, what it left is given AFTER_MS to finish its output and is then killed.
// What was read is kept, and killed says the bound ended it. Callers: git() and vesselGit() (git-commit.ts), trusted()
// and asShellUser() (git-land.ts), the shells sh() and bounded_shell (index.ts), each of which keeps its own watchdog
// inside the command (groupBounded) and is bounded here as a whole.
import { killTree } from "./proc-tree.js";

// How long output is still read after the command ended, or after it was killed at the bound.
export const AFTER_MS = 2_000;

export type Bounded = { stdout: string; stderr: string; exit_code: number; signalled: boolean; killed: boolean; signal: string | null };
// Observers of a run (the shells' [sh-instrument] probe): when it started, when the command exited, when its pipes closed.
export type RunHooks = { spawned?: (pid: number) => void; exited?: () => void; eof?: () => void };

export async function runBounded(argv: string[], o: { cwd: string; env: Record<string, string>; stdin?: Uint8Array; stepMs: number; hooks?: RunHooks }): Promise<Bounded> {
  const p = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdout: "pipe", stderr: "pipe", stdin: o.stdin ?? "ignore", detached: true });
  o.hooks?.spawned?.(p.pid);
  if (o.hooks?.exited) p.exited.then(o.hooks.exited, () => {});
  const dec = { out: new TextDecoder(), err: new TextDecoder() };
  const read = { out: "", err: "" };
  const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
  const drain = async (st: ReadableStream<Uint8Array>, k: "out" | "err"): Promise<void> => {
    const r = st.getReader();
    readers.push(r);
    for (;;) {
      const { done, value } = await r.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      read[k] += dec[k].decode(value, { stream: true });
    }
  };
  const pipes = Promise.all([drain(p.stdout as ReadableStream<Uint8Array>, "out"), drain(p.stderr as ReadableStream<Uint8Array>, "err")]);
  if (o.hooks?.eof) pipes.then(o.hooks.eof, () => {});
  let killed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<void>((r) => { timer = setTimeout(() => { killed = true; killTree(p.pid); r(); }, o.stepMs); });
  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // Ended (or killed at the bound): its output is read for AFTER_MS more at most, then nothing of it is waited on.
  await Promise.race([p.exited.then(() => Promise.race([pipes, pause(AFTER_MS)])), bound.then(() => Promise.race([pipes, pause(AFTER_MS)]))]);
  clearTimeout(timer);
  killTree(p.pid);
  for (const r of readers) void r.cancel().catch(() => {});
  const code = await Promise.race([p.exited, pause(AFTER_MS).then(() => null)]);
  return {
    stdout: read.out,
    stderr: read.err + (killed ? `\n[killed at the step bound (${o.stepMs} ms): the command, or something it started, was still running]` : ""),
    exit_code: killed ? (typeof code === "number" && code !== 0 ? code : 137) : (typeof code === "number" ? code : -1),
    signalled: killed || Boolean(p.signalCode),
    killed,
    signal: p.signalCode == null ? null : String(p.signalCode),
  };
}
