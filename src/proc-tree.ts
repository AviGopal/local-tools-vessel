// Process-tree helpers shared by the script runner (script-runner.ts) and its containment helper
// (script-runner-reaper.ts). Linux /proc only.
import { readdirSync, readFileSync } from "node:fs";

/** Every live descendant of `pid` (children, grandchildren, ...), found by walking /proc ppid links. */
export function descendants(pid: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[] = [];
  try { entries = readdirSync("/proc"); } catch { return []; }
  for (const d of entries) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const list = children.get(ppid) ?? [];
      list.push(Number(d));
      children.set(ppid, list);
    } catch { /* exited */ }
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) for (const c of children.get(stack.pop()!) ?? []) { out.push(c); stack.push(c); }
  return out;
}

/** SIGKILL `pid`'s process group, `pid`, and every descendant. Descendants are collected BEFORE killing:
 *  once a parent dies its children are reparented and the ppid link to them is gone. */
export function killTree(pid: number): void {
  const desc = descendants(pid);
  try { process.kill(-pid, "SIGKILL"); } catch { /* group gone */ }
  for (const d of [pid, ...desc]) { try { process.kill(d, "SIGKILL"); } catch { /* gone */ } }
}
