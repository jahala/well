// A test that leaves a file behind on purpose, for test/runner.test.ts: scripts/test.ts must fail
// a run of it. Its name does not end in .test.ts, so the suite never runs it by itself.
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

test("leaves a file in WELL_TMP", () => {
  writeFileSync(path.join(process.env.WELL_TMP ?? "", "left-behind"), "");
});
