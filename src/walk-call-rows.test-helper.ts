// The rows the walk writes for one call, in the walk's own row shape (walk-vessel calls.ts, once()): a started hop that
// names the shape called (pointer_type), and an ended hop that carries the output under the same call_id but does NOT name
// the shape, and may carry no kind. Fixtures build hop rows only through this, so a test cannot model a row the walk never
// writes (an ended hop naming its pointer_type was such a row, and every reader keyed on it matched nothing live).
export const walkCall = (n: string, pointerType: string, selectionRef: string, output: Record<string, unknown>) => [
  { id: `hs-${n}`, shape: "hop", role: "walk", phase: "started", kind: "call", pointer_type: pointerType, call_id: `call-${n}`, selection_ref: selectionRef },
  { id: `he-${n}`, shape: "hop", role: "walk", phase: "ended", call_id: `call-${n}`, selection_ref: selectionRef, output },
];

// records' read, as the stub records answers it: rows of a shape, of ids, and of every where field equal as strings.
export const recordRead = (rows: Array<Record<string, unknown>>, p: { shape?: string; ids?: string[]; where?: Record<string, unknown> }) =>
  rows.filter((r) => (p.shape === undefined || r.shape === p.shape) && (p.ids === undefined || p.ids.includes(String(r.id)))
    && Object.entries(p.where ?? {}).every(([k, v]) => String(r[k]) === String(v)));

// records' episode answer ({episode: w, roots: "all"}), as records builds it (records-vessel store.ts rootRows): each open
// root with the rows descended from it, which are the root, the walk's selections (writer w) whose pool_refs or input_refs
// hold it, and the walk's rows (writer w) whose selection_ref names one of those selections.
type R = Record<string, unknown>;
export const episodeRead = (rows: R[], w: string, open: string[]) => ({
  shared: [],
  roots: open.map((id) => {
    const held = (r: R) => [r.pool_refs, r.input_refs].flat().map(String).includes(id);
    const sels = new Set(rows.filter((r) => r.shape === "selection" && r.writer === w && held(r)).map((r) => String(r.id)));
    const root = rows.find((r) => r.id === id) ?? { id };
    return { root, rows: [root, ...rows.filter((r) => r.writer === w && (sels.has(String(r.id)) || sels.has(String(r.selection_ref))))], awaits: true };
  }),
});

// records' calls read ({episode: w, calls: [shapes]}), as records builds it (records-vessel store.ts walkCalls): each of
// the walk's started hops of an asked shape, and every call still in flight whatever its shape, with the root its
// selection names, whether that root is open, how the call stands, and the ended hop's output. No selection rides along.
export const callsRead = (rows: R[], open: string[], types: string[]) => {
  const walk = rows.filter((r) => r.role === "walk");
  const sels = new Map(walk.filter((r) => r.shape === "selection").map((s) => [String(s.id), s]));
  const ended = new Map(walk.filter((r) => r.shape === "hop" && r.phase === "ended").map((r) => [String(r.call_id), r]));
  const failed = new Set(walk.filter((r) => r.shape === "failure").map((r) => String(r.call_id)));
  // only a call under the walk's newest selection can be in flight; an unsettled one under an older selection is abandoned
  const newest = walk.filter((r) => r.shape === "selection").reduce<R | undefined>((a, r) => (a === undefined || Number(r.seq ?? 0) >= Number(a.seq ?? 0) ? r : a), undefined);
  const settled = (id: string) => ended.has(id) || failed.has(id);
  const live = (h: R) => !settled(String(h.call_id)) && (String(h.selection_ref) === String(newest?.id) || !sels.has(String(h.selection_ref)));
  return walk.filter((r) => r.shape === "hop" && r.phase === "started" && (types.includes(String(r.pointer_type)) || live(r)))
    .map((h) => {
      const id = String(h.call_id);
      const root = String(sels.get(String(h.selection_ref))?.root ?? "");
      const e = ended.get(id);
      return { call_id: id, type: String(h.pointer_type), selection_ref: String(h.selection_ref), root, open: open.includes(root),
        state: e ? "ended" : failed.has(id) ? "failed" : live(h) ? "started" : "abandoned", seq: Number(h.seq ?? 0), t: String(h.t ?? ""), ...(e ? { output: e.output } : {}) };
    });
};
