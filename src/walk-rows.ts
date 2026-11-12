// The walk's record of a change clone, read from records through discovery. git_worktree's answer is the output of the
// walk's ended hop for that call, so what a clone's base is lives in a row the shell user cannot write (it holds no
// records key), not in a file beside the clone. A commit or a landing in a clone takes its base from that row.
//
// The read goes through discovery, the one configured endpoint, and under METABOB_API_KEY, which on a node is the node
// key every vessel there holds: the same identity and route as every other service. With no discovery endpoint
// configured the read is refused rather than sent to an address written here (index.ts and script-runner.ts still carry
// such a fallback: named debt). A row with role walk is trusted as far as the node key is: any vessel on the node could
// write one, a person key or the shell user (which holds no key) cannot.

export type Made = { cwd: string; repo: string; branch: string; base: string; super_base: string; origin_url: string };
export type Row = { id: string; shape?: string; role?: string; pointer_type?: string; phase?: string; output?: Record<string, unknown>; [k: string]: unknown };

export type Query = { shape?: string; where?: Record<string, unknown>; ids?: string[] };

/** Rows matching a records query (a shape, top-level field equality, ids), read from records through discovery. */
// One request to records through discovery, under the node key: every read here goes through it, so none can drift
// from the others in where it goes or how it says who is asking (records answers 401 to a request with no key).
export const resolveRecords = async (pointer: Record<string, unknown>): Promise<{ ok: true; body: unknown } | { error: string }> => {
  const discovery = process.env.DISCOVERY_ENDPOINT?.trim();
  if (!discovery) return { error: "no discovery endpoint is configured: the walk's rows cannot be read" };
  const key = process.env.METABOB_API_KEY ?? "";
  try {
    const r = await fetch(new URL("/resolve", discovery).href, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(key ? { Authorization: `ApiKey ${key}` } : {}) },
      body: JSON.stringify({ pointer: { type: "record_read", ...pointer } }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return { error: `records answered ${r.status}` };
    return { ok: true, body: (await r.json()) as unknown };
  } catch (e) {
    return { error: `records could not be read: ${(e as Error).name}` };
  }
};

export const readRows = async (q: Query): Promise<Row[] | { error: string }> => {
  const r = await resolveRecords(q);
  if ("error" in r) return { error: `${r.error} (${q.shape ?? "the"} rows)` };
  const rows = Array.isArray(r.body) ? r.body : (r.body as { content?: unknown })?.content;
  return Array.isArray(rows) ? (rows as Row[]) : { error: `records answered no list for ${q.shape ?? "the"} rows` };
};

/**
 * The walk's calls of one shape that ended, as their ended hop rows (which carry the call's output). An ended hop does not
 * name the shape called: its started hop does, under the same call_id, so each ended hop is joined to its started one.
 * (A row that names its own pointer_type counts too.) Only the walk's own rows.
 */
export async function endedCalls(pointerType: string): Promise<Row[] | { error: string }> {
  const [started, ended] = await Promise.all([
    readRows({ shape: "hop", where: { pointer_type: pointerType, phase: "started" } }),
    readRows({ shape: "hop", where: { phase: "ended" } }),
  ]);
  if (!Array.isArray(started)) return started;
  if (!Array.isArray(ended)) return ended;
  const calls = new Set(started.filter((h) => h.role === "walk").map((h) => String(h.call_id)));
  return ended.filter((h) => h.role === "walk" && (h.pointer_type === pointerType || (h.pointer_type === undefined && calls.has(String(h.call_id)))));
}

/**
 * The one change clone the walk made at `cwd` and has not landed. A walk-written git_worktree row must name it: none
 * means git_worktree did not make it, and is refused. Several may, since git_worktree hands an unchanged clone out again
 * rather than making another; they must agree on the repo, branch, base and origin (rows that disagree are a collision,
 * refused), and the latest one's super_base, the super-repo HEAD whose hooks judge, is the one that holds. `where`
 * matches top-level fields only, so the rows are git_worktree's ended hops and their cwd is matched here: a bounded set,
 * the clones made, not every hop.
 */
export async function madeClone(cwd: string): Promise<Made | { error: string }> {
  const made = await endedCalls("git_worktree");
  if (!Array.isArray(made)) return made;
  const mine = made.filter((r) => r.role === "walk" && r.output?.cwd === cwd).sort((a, b) => Number(a.seq) - Number(b.seq))
  if (mine.length === 0) return { error: `no walk row records a clone made at ${cwd}: a commit or landing needs one` };
  const same = (k: string) => new Set(mine.map((r) => String(r.output?.[k] ?? ""))).size === 1;
  // One clone's base moves only by a refresh, which says the base it moved from: each row keeps the one before's base or
  // was refreshed from it. Any other difference is two clones at one place, a collision.
  const chained = mine.every((r, i) => i === 0 || r.output?.base === mine[i - 1].output?.base || r.output?.refreshed_from === mine[i - 1].output?.base);
  if (!["repo", "branch", "origin_url"].every(same) || !chained) {
    return { error: `${mine.length} walk rows record different clones made at ${cwd}: a commit or landing needs one` };
  }
  const landed = await endedCalls("git_land");
  if (!Array.isArray(landed)) return landed;
  if (landed.some((r) => r.role === "walk" && r.output?.cwd === cwd)) return { error: `the clone at ${cwd} has already landed` };
  const o = mine[mine.length - 1].output ?? {};
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  if (!s("base") || !s("super_base") || !s("repo") || !s("branch") || !s("origin_url")) {
    return { error: `the row for ${cwd} lacks its base, repo, branch or origin` };
  }
  return { cwd, repo: s("repo"), branch: s("branch"), base: s("base"), super_base: s("super_base"), origin_url: s("origin_url") };
}

/**
 * The walk's calls of the named shapes, and every call still in flight whatever its shape, each with the root it worked
 * for, whether that root is open, and how it stands (started, ended with its output, or failed), for each walk (by its
 * arm rows): records' calls read, which carries no selection, so its size grows with the calls, not with what the
 * selections saw. A reader that needs which clone went to which request, which landed and what is in flight reads this.
 */
// abandoned: started under a selection older than the walk's newest, neither ended nor failed: the walk stopped mid-call.
// (A call under a selection records does not hold reads as started: it cannot be placed, so it is kept as in flight.)
export type Call = { call_id: string; type: string; selection_ref: string; root: string; open: boolean; state: "started" | "ended" | "failed" | "abandoned"; seq: number; t: string; output?: Row };
export async function walkCalls(walks: string[], types: string[]): Promise<Call[] | { error: string }> {
  const out: Call[] = [];
  for (const episode of walks) {
    const r = await resolveRecords({ episode, calls: types });
    if ("error" in r) return { error: `${r.error} (the walk's calls)` };
    const calls = Array.isArray(r.body) ? r.body : (r.body as { content?: unknown })?.content;
    if (!Array.isArray(calls)) return { error: "records answered no list of the walk's calls" };
    // A records that does not serve the calls read answers the episode instead, a list of rows: taken as calls, nothing
    // would be named or in flight, and every clone would look free. Each item must be a call, or nothing is read.
    const call = (c: unknown): boolean => typeof (c as Call)?.call_id === "string" && ["started", "ended", "failed", "abandoned"].includes(String((c as Call)?.state));
    if (!calls.every(call)) return { error: "records answered rows, not the walk's calls: it does not serve the calls read" };
    out.push(...(calls as Call[]));
  }
  return out;
}
