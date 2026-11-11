// One lock over the change clones, held by whatever chooses or makes a clone (git_worktree) and by whatever decides
// which to remove and removes them (walk_trees_reclaim). Both run in this process; without it, a clone handed out again
// while a reclaim was between deciding and removing could be removed under the call it was handed to.
let tail: Promise<unknown> = Promise.resolve();

export const withClones = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
};
