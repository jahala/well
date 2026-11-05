// Where a test makes its temporary files: under WELL_TMP, which scripts/test.ts makes for each run
// and checks is empty after. A test run any other way has no such check, so it refuses to start
// instead of writing to the system's temporary folder where a leftover would go unseen.
export function scratchRoot(): string {
  const root = process.env.WELL_TMP;
  if (!root) throw new Error("run tests through npm test, or node scripts/test.ts <file>, which make WELL_TMP and check it is empty after");
  return root;
}
