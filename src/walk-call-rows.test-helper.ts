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
