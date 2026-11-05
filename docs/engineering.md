# Engineering in well: how it is tested, and the recipes

## Testing doctrine

- The failing test comes first. A change to the rule starts as a change to the umbrella's vector.
- Tests write real files in a folder under `WELL_TMP`, never a mock of the file system, and never the owner's real ledger folder.
- Tests that touch the Keychain create a throwaway keychain under `WELL_TMP` through `security -i` and delete it after; they never touch the owner's login keychain. A check that a secret stays hidden stores a made-up value and searches every output, file and process argument for it. The check that `well key put` reads with echo off runs well on a pseudo-terminal through an inline Python helper in `test/keys.test.ts`; nothing type-checks that helper yet.
- Time, the folder and the tool are passed in. No test waits on a fixed sleep longer than the lock's own pause.
- `scripts/test.ts` runs the suite, or the test files it is given, then fails if anything is left under `WELL_TMP` or the working tree changed; `test/runner.test.ts` holds that it does. A test that removes its own temporary folder is the one allowed removal. A test refuses to start without `WELL_TMP` (`test/scratch.ts`), so no run writes to the system's temporary folder unchecked. Run one file the same way, `node scripts/test.ts test/ledger.test.ts`, and stamp checks with `tend2 verify <page> --runner "node scripts/test.ts --test-reporter=tap {evidence}"`.
- Output is clean: a passing run prints only the test runner's lines.

## Where CI runs

Both jobs run on GitHub's macOS runners, because the keys tests need `/usr/bin/security` and `/usr/bin/python3`. Self-hosted runners are opt-in only, through the repository variable `CI_RUNS_ON` (such as `["self-hosted", "macOS", "well"]`). It stays unset while the repository is public, so no stranger's pull request runs on a maintainer's machine. The map lint reads jahala/tend, which is private, through a read-only deploy key stored as the `TEND_DEPLOY_KEY` secret; a pull request from a fork cannot see it, so the map lint runs on pushes and on this repository's own branches. Two more steps compare the vector and the manifest schema with the umbrella's copies at their pinned commits, byte for byte. The check job fetches the whole history, because `test/manifest.test.ts` reads the commit `garden.json` pins.

## Recipes

### Take a change to the rule

1. The change lands in the umbrella first: `jahala/plotplot:contracts/fixtures/ledger/vector.json`, with its page.
2. Copy the vector whole to `test/fixtures/ledger-vector.json`, and the lock cases (`jahala/plotplot:contracts/fixtures/ledger/lock.json`) to `test/fixtures/ledger-lock.json`.
3. Write the new commit and each file's sha256 into `test/fixtures/ledger-vector.pin`; CI reads the commit from the pin.
4. Run `npm run check`; change `src/ledger.ts` until every step passes.
5. Tell each client to copy the new vector and pass it.

### Give a client the ledger

A client in any language calls the command and sends only on exit 0:

```sh
well reserve --budget judge --tool my-tool --key "$key" --usd 0.02
# make the call, then
well settle --budget judge --tool my-tool --key "$key" --usd 0.018
# or, if the call never left
well release --budget judge --tool my-tool --key "$key" --why not-sent
```

A client that needs a secret lets well hold it, and reports its charge in the file `WELL_CHARGE` names:

```sh
well run --budget judge --tool my-tool --key "$key" --estimate 0.02 \
  --secret api.example.com/judge --env EXAMPLE_API_KEY -- my-tool call
# inside my-tool, after the call: echo 0.018 > "$WELL_CHARGE"
```

A client that carries the rule itself instead: a client in TypeScript copies `src/ledger.ts` byte for byte, with a pin naming this repository's commit, and passes the vector in its own tests. A client in another runtime implements `jahala/plotplot:contracts/ledger.md` and passes the vector; `jahala/cultivate:cultivate/ledger.py` is the example.
