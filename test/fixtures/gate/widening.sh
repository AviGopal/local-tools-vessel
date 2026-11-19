#!/usr/bin/env bash
# widening.sh — whether a super-repo change widens the gate's authority (H2): the one statement of that rule, read by
# every place that must refuse a widening. candidate.sh asks it at install (base = the accepted sha, policy = the
# accepted copy's); a land onto super asks it before the push (base = the branch it lands on, policy = that base's), so a
# widening is refused before it reaches a public branch, not only when a node would install it.
#
#   widening.sh --policy <gate-policy.json> --super <clone> --base <sha> --head <sha> [--gate-manifest <MANIFEST.json>]
#
# --policy is the BASE's policy (the copy being widened), never the head's: a head may not judge itself.
# --gate-manifest limits the fixture rule to gate paths as that manifest names them ("!" globs excluded), as candidate.sh
# reads them from accepted/; without it every path the policy's fixture_paths match counts.
#
# A widening is any of:
#   - a path matching fixture_paths whose status is not an ordinary one (classifier.fixture_ordinary_status, default A):
#     an accepted fixture edited or removed;
#   - the head's policy dropping a gate_paths or fixture_paths entry the base names;
#   - the head's policy adding a non_root_paths entry;
#   - the head's policy lowering soak_ticks.default or raising soak_ticks.max, or not being a JSON object;
#   - the head's policy calling more fixture changes ordinary than the base's: classifier.fixture_ordinary_status may
#     stay as it is or get shorter; a status the base does not list, a list that is not strings, or no list is a widening;
#   - the head's policy holding any of those keys with a value of the wrong type (it cannot be compared).
#
# stdout: one line per widening. Exit 0: none. Exit 1: at least one. Exit 2: it cannot be judged (an unreadable policy,
# a base policy holding a value of the wrong type, a gate manifest with no list of gate_paths, a base or head that is not
# a commit in the clone): a caller refuses on 2 as on 1, never reads it as no widening.
set -uo pipefail
POL=""; SUPER=""; BASE=""; HEAD=""; MAN=""
while [ $# -gt 0 ]; do
  case "$1" in --policy) POL="$2"; shift ;; --super) SUPER="$2"; shift ;; --base) BASE="$2"; shift ;;
    --head) HEAD="$2"; shift ;; --gate-manifest) MAN="$2"; shift ;; esac; shift
done
[ -n "$POL" ] && [ -n "$SUPER" ] && [ -n "$BASE" ] && [ -n "$HEAD" ] \
  || { echo "usage: widening.sh --policy P --super S --base SHA --head SHA [--gate-manifest M]" >&2; exit 64; }
POLICY_REL=scripts/substrate/gate/gate-policy.json
# Every value judged here is checked for its type before it is compared, and every read checks its own exit status: a
# value jq cannot compare (a string where a list belongs, a list where an object does) would otherwise make the clause
# say nothing, and nothing reads as "no widening". On the base that is "cannot judge" (exit 2); on the head, a widening
# naming the key. Lists of paths or statuses are lists of strings, soak_ticks an object of numbers, classifier an object;
# each may be absent (read by its default), never null.
SHAPE='def strs: type == "array" and all(.[]; type == "string");
  if type != "object" then "is not a JSON object" else
    (("gate_paths", "fixture_paths", "non_root_paths") as $k | select(has($k) and (.[$k] | strs | not)) | "\($k) is not a list of strings"),
    (if has("soak_ticks") and (.soak_ticks | type) != "object" then "soak_ticks is not an object"
     elif has("soak_ticks") then .soak_ticks | ("default", "max") as $k | select(has($k) and (.[$k] | type) != "number") | "soak_ticks.\($k) is not a number"
     else empty end),
    (if has("classifier") and (.classifier | type) != "object" then "classifier is not an object"
     elif (.classifier | type) == "object" and (.classifier | has("fixture_ordinary_status")) and (.classifier.fixture_ordinary_status | strs | not)
       then "classifier.fixture_ordinary_status is not a list of strings"
     else empty end)
  end'
base_bad="$(jq -r "$SHAPE" "$POL" 2>/dev/null)" || { echo "cannot judge: the base policy $POL is not readable JSON"; exit 2; }
[ -z "$base_bad" ] || { echo "cannot judge: the base policy $POL: $(tr '\n' ';' <<< "$base_bad")"; exit 2; }
for s in "$BASE" "$HEAD"; do
  git -C "$SUPER" cat-file -e "$s^{commit}" 2>/dev/null || { echo "cannot judge: $s is not a commit in $SUPER"; exit 2; }
done

in_globs() { # path globs... -> 0 when any glob matches ('*' crosses '/')
  local p="$1" g; shift
  for g in "$@"; do [[ "$p" == $g ]] && return 0; done; return 1
}
GATE=()
if [ -n "$MAN" ]; then
  jq -e '.gate_paths | type == "array" and all(.[]; type == "string")' "$MAN" >/dev/null 2>&1 \
    || { echo "cannot judge: the gate manifest $MAN has no list of gate_paths strings"; exit 2; }
  mapfile -t GATE < <(jq -r '.gate_paths[]' "$MAN")
fi
is_gate() { # path -> without a manifest, every path; else a manifest gate glob matches and no "!" exclusion does
  [ -n "$MAN" ] || return 0
  local p="$1" g hit=1
  for g in "${GATE[@]}"; do
    if [[ "$g" == '!'* ]]; then [[ "$p" == ${g#!} ]] && return 1; else [[ "$p" == $g ]] && hit=0; fi
  done
  return $hit
}
mapfile -t FIX < <(jq -r '.fixture_paths[]?' "$POL")
mapfile -t ORD < <(jq -r '.classifier.fixture_ordinary_status[]?' "$POL")
[ "${#ORD[@]}" -gt 0 ] || ORD=(A)

WIDEN=()
changed="$(git -C "$SUPER" diff --name-status --no-renames "$BASE" "$HEAD" 2>/dev/null)" \
  || { echo "cannot judge: no diff between $BASE and $HEAD in $SUPER"; exit 2; }
while IFS= read -r line; do
  [ -n "$line" ] || continue
  st="${line%%$'\t'*}"; p="${line#*$'\t'}"
  is_gate "$p" || continue
  if [ "${#FIX[@]}" -gt 0 ] && in_globs "$p" "${FIX[@]}"; then in_globs "$st" "${ORD[@]}" || WIDEN+=("$st $p (accepted fixture edited or removed)"); fi
done <<< "$changed"

head_pol="$(git -C "$SUPER" show "$HEAD:$POLICY_REL" 2>/dev/null || echo '{}')"
clause() { # <what it compares> <jq program over the base, $c = the head's policy> -> each line it prints is a widening
  local out
  if out="$(jq -r --argjson c "$head_pol" "$2" "$POL" 2>/dev/null)"; then
    while IFS= read -r w; do [ -n "$w" ] && WIDEN+=("$POLICY_REL $w"); done <<< "$out"
  else
    WIDEN+=("$POLICY_REL: $1 cannot be compared")
  fi
}
# A head policy that is not a JSON object, or holds a value of the wrong type, cannot be compared, so it is a widening
# (never read as "no change"); a head with no policy at all reads as {} and drops every entry.
if ! head_bad="$(jq -r "$SHAPE" 2>/dev/null <<< "$head_pol")"; then
  WIDEN+=("$POLICY_REL is not a JSON object, so nothing in it can be compared")
elif [ -n "$head_bad" ]; then
  while IFS= read -r w; do WIDEN+=("$POLICY_REL $w, so it cannot be compared"); done <<< "$head_bad"
else
  # Dropping a protected or fixture glob, or ADDING a non-root exclusion, is a widening, whatever the files say: a head's
  # policy may only grow the gated set.
  clause "gate_paths and fixture_paths" '("gate_paths", "fixture_paths") as $k | ((.[$k] // []) - ($c[$k] // []))[] | "drops \($k) entry '"'"'\(.)'"'"'"'
  clause non_root_paths '(($c.non_root_paths // []) - (.non_root_paths // []))[] | "adds non_root_paths entry '"'"'\(.)'"'"'"'
  # The soak may only get STRICTER: lowering the floor (soak_ticks.default) or raising the cap the shaped row may reach
  # (soak_ticks.max) relaxes or re-delegates the gate.
  clause soak_ticks '
    (.soak_ticks.default // 3) as $ad | (.soak_ticks.max // 12) as $am
    | ($c.soak_ticks.default // 3) as $cd | ($c.soak_ticks.max // 12) as $cm
    | (if $cd < $ad then "lowers soak_ticks.default \($ad) -> \($cd)" else empty end),
      (if $cm > $am then "raises soak_ticks.max \($am) -> \($cm)" else empty end)'
  # What counts as ordinary may only narrow: a head that adds a status would let the NEXT candidate, judged under it, edit
  # or remove accepted fixtures as ordinary, so the gate could loosen itself in two steps. Compared as the classifier reads
  # each list (an empty one reads as A, above); the head's must be there, since an absent list hands its meaning to the
  # default in code the same change could edit. So no list says "nothing ordinary": reading [] as none here would change
  # what the classifier itself does with [], so the two change together or not at all.
  clause classifier.fixture_ordinary_status '
    def reads: if type == "array" and length > 0 then . else ["A"] end;
    (.classifier.fixture_ordinary_status | reads) as $b | ($c.classifier.fixture_ordinary_status) as $h
    | if $h == null then "widens classifier.fixture_ordinary_status \($b) -> null (not a list of statuses)"
      elif (($h | reads) - $b | length) > 0 then "widens classifier.fixture_ordinary_status \($b) -> \($h)"
      else empty end'
fi
[ "${#WIDEN[@]}" -gt 0 ] || exit 0
printf '%s\n' "${WIDEN[@]}"
exit 1
