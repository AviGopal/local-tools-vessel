// script-runner-reaper — the containment parent of one allowlisted script run (script-runner.ts).
//
// Usage: bun script-runner-reaper.ts <command> [args...]   (stdio is inherited from the runner)
//
// WHY. The runner kills a run's tree by walking /proc from the process it spawned. A script that
// double-forks (a subshell starting a `setsid` daemon, then exiting) leaves an orphan the kernel
// reparents to the nearest CHILD SUBREAPER, or to init, out of that tree and outside its process group.
// The runner then cannot find it, and if the orphan holds stdout, the run never ends.
//
// WHAT. This process marks itself a child subreaper (prctl PR_SET_CHILD_SUBREAPER via bun:ffi), so every
// orphan of the script reparents HERE and stays visible as this process's descendant. It runs the script,
// waits for it, kills whatever is still below it, and exits with the script's exit code. On a timeout the
// runner SIGKILLs this process's tree, which now includes adopted orphans.
//
// WHY A SEPARATE PROCESS, never the vessel itself: a subreaper adopts every orphan below it, and Bun reaps
// only the children it spawned, so a vessel-wide subreaper would collect zombies from every shell command
// forever. This process lives exactly as long as one run; its zombies go to init when it exits.
//
// FAIL CLOSED. If prctl is unavailable, nothing runs: exit 125 with a marker on stderr.
import { dlopen, FFIType } from "bun:ffi";
import { descendants } from "./proc-tree.js";

const PR_SET_CHILD_SUBREAPER = 36;
export const REAPER_UNAVAILABLE_EXIT = 125;

function becomeSubreaper(): boolean {
  for (const lib of ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1", "libc.so"]) {
    try {
      const libc = dlopen(lib, { prctl: { args: [FFIType.i32, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.i32 } });
      const rc = libc.symbols.prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
      libc.close();
      return rc === 0;
    } catch { /* try the next name */ }
  }
  return false;
}

/** Kill everything below this process. Bounded passes: adopted zombies stay listed until this exits. */
function killDescendants(): void {
  for (let pass = 0; pass < 3; pass++) {
    const d = descendants(process.pid);
    if (d.length === 0) return;
    for (const p of d) { try { process.kill(p, "SIGKILL"); } catch { /* gone */ } }
  }
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) { process.stderr.write("[script-runner-reaper] no command\n"); process.exit(2); }
  if (!becomeSubreaper()) {
    process.stderr.write("[script-runner-reaper] REFUSED: cannot become a child subreaper (prctl PR_SET_CHILD_SUBREAPER); not running the script uncontained\n");
    process.exit(REAPER_UNAVAILABLE_EXIT);
  }
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit", env: process.env });
  const code = await child.exited;
  killDescendants();
  const sig = child.signalCode ? (require("node:os").constants.signals as Record<string, number>)[child.signalCode] : undefined;
  process.exit(typeof sig === "number" ? 128 + sig : (code ?? 1));
}
