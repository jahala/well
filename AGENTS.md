# well

well is the garden's one door for every call that costs money or needs a key. A program that is about to spend reserves the estimate in a shared ledger first, is refused when the budget the owner set would be passed, settles what was charged after, and never resends a call that may already have been charged. Read this page, then `docs/tend2/well.tend2.html` (the bet), then the loop you are working on.

## What well is for, and what it is not

well is for an owner whose tools spend money on their own: judge calls, model calls, searches, ads, domains. Each tool that keeps its own cap stays under it while together they overspend, a call that timed out may already have been charged, and keys sit where agents can read them.

Today well holds three parts. The shared ledger (`src/ledger.ts`) keeps the rule, which lives in a test vector in the umbrella. The command (`src/cli.ts`) lets a client in any language spend through it: `well reserve`, `well settle`, `well release`, `well status` and `well breaches`. The door for keys (`src/keychain.ts`, `src/run.ts`) makes well the only thing a cooperating client asks for a secret (not a lock: any program running as the owner can read an item well stored, `docs/architecture.md`): `well run` gives one paid call its secret, `well key set` stores a generated one, and `well key put` stores one a provider issued, read from standard input. Two clients still carry the rule themselves: cultivate in Python, and the owner's judge runner as a pinned copy of `src/ledger.ts`; each may call the command instead. Budgets for subscription seats are planned (`docs/tend2/seats.tend2.html`); so far two sources of window readings are built: `well seat note`, which a Claude Code `statusLine` setting runs, and the conductor source (`src/conductor.ts`), which reads the rate-limit events the Conductor app stores, for a machine whose sessions run through it.

well is not:

- a proxy or a server. It is a library and a command over files (law §1 invariant 2, §6).
- a decider of what to spend on. The calling tool decides; well only allows or refuses.
- an approver of large spends. That is gate's, through the owner.
- a store of answers. Each client keeps its own recorded answers for replay; the ledger holds money.

## Shape

| Layer | Holds | May depend on |
|---|---|---|
| core | `tally()`, `decide()`: the rule, pure, over ledger lines | nothing |
| io | `appendEvent()`, `readStatus()`, `readBreaches()`, `readBudget()`, `readTotals()`: the folder, the lock, the files, the running totals | core |
| keys | `readSecret()`, `setSecret()`, `runWithSecret()`: the Keychain through `/usr/bin/security`, passed in; the child | io |
| command | `src/cli.ts`: reads the arguments, the clock and the home folder; prints one JSON line; exits 0 allowed, 1 refused (a Keychain failure included), 2 usage error, 3 a fault: the folder could not be read or written, or a read was locked out | io, keys |

I/O takes the folder, the moment and the tool as arguments. Only the command reads the clock, the environment, the home folder and the temporary folder, and it passes them in; the lock's own age against a directory's mtime is the one named exception. `test/layers.test.ts` holds both this and which layer each module may import. The long form, with every decision and the alternatives turned down, is `docs/architecture.md`.

## Glossary

- **budget**: a cap per month the owner sets in `~/.local/share/well/budgets.json`, such as `judge` at $20 a month, with an optional `day_usd` and `week_usd` that pace it.
- **pacing**: a reserve must fit the month, the week (the 10,080 minutes up to its own) and the day (the 1,440 minutes up to its own). A budget without its own day or week limit gets the cap times 3/30 a day and times 1.5/4 a week.
- **ledger**: one append-only JSON Lines file per budget per month.
- **running totals**: `<budget>/state.json`, derived from the ledger alone: what it has folded of each month file, and what that adds up to. It can always be rebuilt from the ledger.
- **reserve**: the line written before a call, holding its estimate.
- **settle**: the line written after a call, holding what was charged.
- **release**: the line that frees a reservation whose call never left (`not-sent`), was refused by the provider without charge (`refused`), or that a person checked against the bill (`reconciled`).
- **open reservation**: a reserve with no later settle or release for the same key, in any month up to this one. It stays open however old, until a person clears it with `release --why reconciled`.
- **key**: the sha256 of a request's canonical form, computed by the client.
- **client**: a program that spends through well.
- **secret**: a Keychain item named `<service>/<account>`, read only by well and handed only to the call that needs it.
- **charge file**: the file `WELL_CHARGE` names, where a child of `well run` writes what it was charged, or `not-sent` or `refused`.
- **breach**: a month whose settled spend passed the highest cap its reserve lines carry, or today's cap for a month written before reserves carried one. `well breaches` counts them; it is the bed's metric and must stay zero.
- **vector**: the umbrella's sequence of events with the decision each must get; the rule's home.

## Invariants

1. Reserve before send. No paid call leaves without an allowed reservation.
2. The cap holds across clients. For the month, the week and the day, spent in it plus every open reservation plus the estimate is at most its limit, compared in millionths.
3. Never resend blind. A key with an open reservation is refused until it settles or is released.
4. No budget, no spend. A client that finds no budget for what it would spend refuses.
5. Nothing is rewritten. A mistake is corrected by a later event, never by editing a line.
6. The vector is the rule. `src/ledger.ts` and every client pass it, and a change to the rule is a change to the vector in the umbrella first.
7. One writer at a time, through a directory lock; a lock older than a minute belongs to a dead writer and may be removed, by one waiter at a time, holding a second lock and checking the lock's age again under it.
8. No secret is printed, logged, written to a file or passed on a command line.

## Hard limits

- Delete with `trash`, never `rm`; a run may remove only a temporary folder it created itself. Never `git reset`. Never force-push. Never touch the git stash.
- No mocks, stubs, TODOs, fallbacks or compatibility shims in committed code. Never delete or skip a failing test.
- No em dashes. Plain, complete sentences. Name no product well competes with.
- Work only in this repository. A fault in a client is an issue on that client's repository, with evidence.

## What done means

A loop is done when every check on it carries a stamp written by `tend2 verify`. Evidence is a test that exits 0 having counted at least one test; a run that counted nothing, or a test that mocks the unit it covers, is not evidence. Each piece of work ends with dated `## Tried` lines on the loop it worked.

`docs/architecture.md` holds the decisions and their reasons. `docs/engineering.md` holds the testing doctrine and the recipes.
