# Architecture of well: the shape, and every decision with its reason

The core page (`AGENTS.md`) states the shape in a few lines. This page holds the long form and the decisions, each with the alternative turned down. The design is drafted in the umbrella (`jahala/plotplot:docs/ideas/well.md`); the contract is `jahala/plotplot:contracts/ledger.md`.

## Why well exists now

On 2026-10-26 two programs spent on one judge key with separate caps: cultivate's judge and the owner's judge runner, used by glean. Each stayed under its own cap, and nothing stopped them overspending together. cultivate proposed that both write one ledger in the shape well would keep, and the rule was written once, as a test vector in the umbrella. The owner's judge runner gained the ledger the same night, inside the owner's skills folder, which has no version history. This repository was created on 2026-10-27, on the owner's word, so the ledger has a home with history before anything else is built.

## The shape

- `src/ledger.ts`: `tally()` and `decide()`, the rule, pure; `appendEvent()`, `readStatus()`, `readBreaches()` and `readBudget()`, the I/O.
- `src/cli.ts`: the command, `well`. It reads the arguments, the clock and the home folder, calls the library, prints one JSON line and sets the exit code.
- `src/keychain.ts`: `readSecret()` and `setSecret()`, the only code that touches the Keychain, through a `security` function passed in.
- `src/run.ts`: `runWithSecret()`, one paid call with its secret: reserve, read, start the child, then settle, release or leave open.
- `test/ledger.test.ts`: every step and case of the vector and every umbrella lock case, plus the cases they do not cover (no budget, an amount the ledger cannot hold, a stale and a live lock).
- `test/command.test.ts`: the command as a child process against real files, step by step beside the library, plus status, breaches, usage errors and the clock.
- `test/keys.test.ts`: `well run` and `well key set` against throwaway keychains, with a made-up secret searched for everywhere it must not be.
- `test/manifest.test.ts`: `garden.json` against the umbrella's manifest schema, and its claims against this tree.
- `test/fixtures/ledger-vector.json` and `test/fixtures/ledger-vector.pin`: the umbrella's vector, copied whole, and the commit and sha256 it was copied at. `test/fixtures/manifest.schema.json` and its pin do the same for the manifest schema.
- `scripts/test.ts`: runs the suite and fails if a run leaves anything behind.

## Decisions

### The vector is the rule's home

Why: the rule lives in two runtimes (cultivate's Python and the judge runner's TypeScript), and the garden's rule is that a rule two runtimes share is written once with a test comparing their answers. The vector is that one writing. Each client and this repository pass it.

Turned down: one implementation called by both through a command. It would have been the right shape, but no command existed and cultivate needed a door the same day. Now that the command exists, clients may call it instead of carrying the library; the vector stays the rule.

### One command, one JSON line, the exit code as the answer

Why: a client in any language can run a command and read its exit code, so the rule needs no second implementation. Exit 0 is allowed and 1 is refused, with the reason in the line; 2 is a usage error, which writes nothing; 3 is a ledger folder that could not be read or written. A caller that sends only on exit 0 is safe whatever went wrong. The line on standard output is the only output, so a caller never parses a mix. `well run` is the one exception: its standard output is the child's, so well's line goes to standard error, and once the child has started well exits with the child's code.

Turned down: exit 1 for every failure. A broken budgets file would then read as a refusal, and nobody would look at it.

The error policy, which every module follows: an outcome the caller acts on is a value, a discriminated union such as `Decision` or `Stored`, and a refusal among them exits 1; a fault in the files is thrown and becomes exit 3 at the one catch in `src/cli.ts`. `status` and `breaches` wait for the lock only two seconds, since a writer holds it for milliseconds, and a read the lock keeps out exits 3, `locked`, so it is never read as a breach or a refusal. When `well run` cannot write the release for a call that never left, its report says `left_open` with the reason, so the caller knows the request stays blocked until a person reconciles it.

The money commands read the clock at the call and take no `--at`. With it, a caller could reserve in an empty far-future month against a full one, or reserve a key that was still open in the real month. A test that needs history in another month writes it through the library, which takes the moment as an argument.

An amount given as text, by a flag or by a child's charge file, passes one check, `parseDollars()`: a plain decimal with at most six places and at most $1,000,000. Before it, a number too long to be finite was written as `null` and counted as nothing spent, and an amount under a millionth held nothing. The library refuses an amount it cannot hold the same way, so a client that calls it directly cannot write one either.

### The secret travels on standard input and in one environment variable

Why: any process can read another's arguments, so a secret never goes in one. It reaches `security` on standard input, to store, and comes back on standard output, to read. The child gets it in the one environment variable the caller names; on this macOS, `ps -E` does not show another process's environment (checked 2026-10-26). `security` runs by its full path, so nothing earlier on `PATH` can stand in for it.

### The door for keys holds for clients that cooperate, not against one that does not

Why: well stores each secret as a Keychain item that trusts `/usr/bin/security`, so it reads back without a prompt, and any program running as the owner can run that same command for the same item. `well run --dir` with a budgets file the caller wrote itself would also hand over any secret. So the door is a convention: every client the owner runs asks well, which reserves before it reads and never prints what it reads, and an agent that ignores the convention is not stopped by it. Enforcing it would need an item that only a signed program may read, or a separate keychain that stays locked, and well, a TypeScript script run by Node, can be neither yet. `--dir` stays, because a client that keeps its ledger elsewhere needs it, and refusing it would close one way in out of many.

Turned down: refusing `--dir` for `well run`, which would look like a lock while the Keychain itself stays open.

### The Keychain is asked only after the reservation is allowed

Why: a refused call needs no secret, so a refused reservation never reads one and never starts the child. A missing or empty secret, or a command that cannot start, releases the reservation as `not-sent`, because nothing left the machine.

### The child reports its charge in a file

Why: the child's standard output and error belong to the caller, and an exit code cannot carry dollars. A file whose path is in `WELL_CHARGE` is the simplest channel any language or shell can write that cannot mix with the child's own output. It holds dollars as a plain decimal to settle, or `not-sent` or `refused` to release. A child that writes nothing, or something else, leaves the reservation open, because the call may already have been charged; a person reconciles it.

Turned down: a last line on standard output, which well would have to capture and strip from the child's output, and a third file descriptor, which a shell script cannot write as easily as a file.

### The secret is named with --secret, not --key

Why: `--key` is the request's sha256 in every other command, and `well run` needs that key too, to keep the rule that a call is never resent blind. The handover and the first order named the Keychain item `--key`; one flag with two meanings in one command would invite a caller to pass the wrong one.

### key set never replaces a secret

Why: replacing a key in place loses the old one for good, and anything still using it breaks. `well key set` refuses an item that exists. Its secret is 32 random bytes as hex, so the value never starts with a dash that `security` would read as a flag. It is read back after the store, and an empty or different read is removed and refused.

### key put reads standard input, with echo off on a terminal

Why: a key a provider issues has to come in from outside, and an argument is the one place any process can read it. `well key put` reads one line from standard input. On a terminal a small shell does the reading: it saves the terminal's settings and restores them however it ends, by Return, Ctrl-C, a hang-up or a kill; it turns echo off before it asks, and refuses to ask (`echo-not-off`) if echo did not go off; after the line it drains whatever else was pasted, so no further line runs in the owner's shell, and refuses (`more-than-one-line`). From a pipe it reads to the end and refuses more than one line.

It refuses a value with a space, quote, backslash or any character outside printable ASCII. `security -i` reads such a character as the end of the value, and a newline would start a second command on its line. Every API key the garden uses fits; quoting for `security`'s parser would be one more rule to get right.

### Tests use throwaway keychains

Why: a test must never touch the owner's login keychain. Each test creates a keychain file under `WELL_TMP` through `security -i`, which keeps it off the owner's search list, and deletes it after; a run that crashes leaves the file where the leftover check finds it. The echo check needs a real terminal, which Node cannot make, so it drives well through a pseudo-terminal from Python's `pty` module in `/usr/bin/python3`; the macOS `script` command refuses to run without a terminal of its own.

### seat note never fails the session

Why: a `statusLine` command runs on every render of every Claude Code session, so a fault in it would show in front of the owner all day. `well seat note` prints one plain line and exits 0 whatever happens: an error prints a line that starts with `well:`. That line never carries an error's text: a parse error quotes the text around the fault, and the login config can hold a key, so the statusLine input and the config each have a fixed line, and any other fault shows only its code. It waits for the lock only briefly and skips the reading when it cannot have it, because a status line must never hold up a session. It appends a reading only when the session's last line that day says something different, so the log grows with changes in the window, not with renders. Each reading records the account the login config names at that moment, its `accountUuid` and never its email, because a seat belongs to one account, one machine may hold more than one, and a running session follows a change of login.

### The conductor source, for sessions the Conductor app runs

Why: a Claude session the Conductor app starts runs through the SDK, and SDK sessions run no `statusLine`, so `well seat note` sees none of them. Conductor stores the SDK's own `rate_limit_event` for every answer in its database. `src/conductor.ts` reads those, on these terms: the database is opened read-only through a `mode=ro` file URI and never written; only each event's Claude session id, its time and its window fields are selected, never message content or any other column; and a missing table or field is a named failure, `conductor-schema`, never a silent empty read, because Conductor's schema is not well's and may change. A single row whose content is not JSON is skipped and counted as `unreadable`, so one bad row never stops the read. It is one adapter at the edge, beside the statusLine source. On a machine without Conductor it reads nothing and says so.

Turned down: asking Conductor for a statusLine of its own, which is not ours to build, and parsing the SDK stream inside well, which would make well a proxy.

### Pacing inside the month, counted by the minute

Why: a monthly cap alone lets one tool's busy night take a month from every other spender. A reserve now fits three limits: the month's cap, the week's and the day's. The windows roll, so no midnight lets two days through at once, and need no time zone; they count whole minutes, because the judge ledger's 68,945 settles of one week fell in 608 minutes, so the running totals keep one sum per minute instead of every settle, and a decision stays flat. A budget's own `day_usd` and `week_usd` win; without them a day is the cap times 3/30 and a week the cap times 1.5/4. The rule is the umbrella's vector, `pacing`.

### A decision folds in only what is new

Why: the judge ledger reached about 180,000 lines by 2026-11-04, and every decision reread the month under the lock, so writers queued; on that day four cultivate runs waited past 10 seconds, and three charged calls went unrecorded until settled by hand. Each budget now keeps running totals in `<budget>/state.json`: for each month file the bytes it has folded, the spend per month, the open reservations and the torn lines. A decision folds in only the bytes written since, under the lock, and rewrites the state through a rename. A writer that never touches the state, such as an older copy, is still counted, because the next decision folds whatever follows the recorded position. A missing or unreadable state, a month older than the newest that grew, or a file that shrank means a rebuild from the whole ledger, which gives the same totals. A trailing partial line is not folded; it is read each time, as a full reread would read it. On a copy of the real ledger the first decision took 135 ms to build the state and each one after it 2 to 3 ms; the test holds the totals equal to a full reread across random histories, and a decision's cost flat from 1,000 lines to 200,000.

Turned down: an index of every line, which grows with the ledger; and snapshots on a timer, which would need something running.

### A torn last line is skipped and counted, never rewritten

Why: a writer that dies mid-append leaves its last line half written, and on 2026-11-04 one such line halted every tool's spending, because every reader failed on it. That writer never returned an answer, so its caller never sent the call, and the line holds no event. Readers skip any line that is not a whole event and count it; `well status` shows `torn_lines` when there is one, so a person can look. The next writer starts its event on a fresh line, so it is never glued to the fragment, which is left as it was (invariant 5). The seat log follows the same rule.

### Readers take the writers' lock

Why: `well status` and `well breaches` read a file a writer may be appending to. Holding the same directory lock means no half-written line is ever read. A budget nobody has spent on is read without a lock, so reading writes nothing.

### A breach is judged against the cap the month was spent under

Why: a settle may exceed its estimate, so spend can pass a cap even when every reservation fit; `well breaches` counts those months, and the bed's metric is that count, which must be zero. The budgets file holds only the cap in force now, so a cap the owner changed later would move the line for every earlier month. Each reserve line now carries `cap_usd`, the cap it was decided under, and a month breaches when its settled spend passes the highest cap its reserves carry. A month written before reserves carried the cap is judged against today's cap, and `well breaches` names which cap it used: `ledger` or `budgets`. The rule came from the umbrella's vector (jahala/plotplot PR 170), as every change to the rule must.

Turned down: judging every month against today's cap, which let a raised cap hide an old breach.

### A bed from its first command, installed from a clone

Why: `garden.json` was a planted repository's until well had a command, an install and a metric; the pull request that shipped the command made it a bed's. The install pins a commit by its full sha, kept in master's history by a merge commit, and `test/manifest.test.ts` holds that the commit carries the command. Node will not strip types from a file under `node_modules`, so the command runs from a clone linked with `npm install -g .`.

Turned down: a build step that compiles to JavaScript for a copied install. Clients on the owner's machine run from clones, and a build step is one more thing to keep in step with the source.

### TypeScript run directly by Node

Why: the garden's other new tools (glean, mull) are TypeScript run by Node with no build step and tested with `node:test`. The judge runner imports a byte-identical copy of `src/ledger.ts`, which Node runs directly, so a client needs no build either.

Turned down: plain JavaScript, which a client on an older Node could run, at the price of an untyped core; every client on the owner's machine runs Node 24 or later.

### A directory as the lock

Why: creating a directory is atomic on every filesystem and the same call in every runtime, so a Python client and a Node client share one lock with no dependency. A lock older than a minute belongs to a writer that died. Only one waiter may remove it: it first takes a second directory, `<ledger>.lock.break`, and checks the lock's age again under it. Without that, a waiter that saw the old lock could remove the fresh one another writer had just taken, and two writers would decide at once; under contention that passed the cap in 5 of 20 trials. A lock gone when its holder releases it is a named fault. The breaker is not yet in the umbrella's contract, so a client that removes a stale lock without it can still race well (named to cape-town, 2026-10-27).

Turned down: file locks through the operating system, which differ by runtime and platform.

### No server, no proxy

Why: law §1 invariant 2 (files are the substrate) and §6 (not a proxy). The caller still makes the call; well only records and decides.

## What comes next, each as its own loop

- **Seats:** subscription windows as budgets, measured in the provider's own reading of the window and the sessions running at once, not dollars. The loop is `docs/tend2/seats.tend2.html`.

## Data and its lifetime

One ledger file per budget per month, kept. One running-totals file per budget, `<budget>/state.json`, rewritten in place; it holds one number per month and one per open reservation, and can be removed at any time, because the next decision rebuilds it. One seat log per provider per day, `seats/claude/<yyyy-mm-dd>.jsonl`, kept: it gains a line only when a session's reading changes, which is a few hundred lines a day at most. Months older than a year may be compacted to one summary line per budget, kept for the books. The budgets file, `~/.local/share/well/budgets.json`, is the owner's and changes only by the owner's word. It is read strictly: each budget is exactly a `period` of `"month"` and a `cap_usd` that is a number of dollars at least 0. Any other shape, an unknown field included, is a fault that exits 3 and names it, because a mistyped limit that is silently ignored would never hold.
