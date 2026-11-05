// What a run left behind: the lines of the tree's status after the run that
// were not there before it. A line the run removed is not a leftover.
export function leftovers(before: string[], after: string[]): string[] {
  const seen = new Set(before);
  return after.filter((line) => !seen.has(line));
}
