# well

well is one door for every call that costs money or needs a key. A program reserves its estimate before it sends, and well refuses when everything spent and held would pass the budget. After the call the program settles what it was charged, and a call that may have been charged is never sent again blind.

It is a command and a TypeScript library over plain files. It runs no server and makes no network calls.

```
$ key=$(printf '%s' '{"model":"judge-1","question":"Is this the same request?"}' | shasum -a 256 | cut -d' ' -f1)

$ well reserve --budget judge --tool my-tool --key "$key" --usd 0.02
{"ok":true}

$ well reserve --budget judge --tool my-tool --key "$key" --usd 0.02
{"ok":false,"reason":"unsettled"}

$ well settle --budget judge --tool my-tool --key "$key" --usd 0.018
{"ok":true}

$ well status --budget judge
{"ok":true,"budget":"judge","period":"2026-11","spent_usd":0.018,"held_usd":0,"cap_usd":20,"day":{"spent_usd":0.018,"limit_usd":4},"week":{"spent_usd":0.018,"limit_usd":10}}
```

The second reserve is refused because the first is still open: its call may have been charged, so the same request waits until it settles. Every call prints one line of JSON and exits 0 when allowed, so a caller sends only on exit 0.

## Why

Tools that spend money on their own each keep their own cap, so each stays under it while together they overspend. A call that timed out may already have been charged, and a plain retry pays twice. Keys sit in environment variables and files where any agent can read them.

well puts every spender of a budget on one ledger. One program's call in flight counts against the next program's reservation, the cap holds across all of them, and a request with an open reservation is refused until a person or a settle closes it.

## What it doesn't do

- It doesn't make the paid call. The calling program does, and well only allows or refuses.
- It doesn't decide what to spend on, or approve large spends.
- It doesn't store answers. Each program keeps its own recorded responses.
- It doesn't run as a server or a proxy. It is a command and a library over files on one machine.

## Install

well needs Node 24 or later and runs with no build step. Clone it and link the command:

```sh
git clone https://github.com/jahala/well.git
cd well
npm install -g .
```

Node does not run TypeScript from inside `node_modules`, so installing a copy (from a tarball, or through npm from the git URL) does not work. Link a clone as above.

## Budgets

The owner sets each budget in `~/.local/share/well/budgets.json`:

```json
{"judge": {"period": "month", "cap_usd": 20, "day_usd": 4, "week_usd": 10}}
```

A reserve must fit the month, the week and the day. The day is the 1,440 minutes up to the reserve, and the week the 10,080 minutes, so no midnight lets two days of spending through at once. `day_usd` and `week_usd` are optional; without them a day is the cap times 3/30 and a week the cap times 1.5/4. A budgets file in any other shape stops every spender with a named error, because a limit that is silently ignored never holds.

```
$ well reserve --budget judge --tool my-tool --key "$other" --usd 4.5
{"ok":false,"reason":"cap-day"}
```

## Spending through well

| Command | What it does |
|---|---|
| `well reserve --budget B --tool T --key K --usd N` | holds an estimate before a call |
| `well settle --budget B --tool T --key K --usd N` | records what the call was charged |
| `well release --budget B --tool T --key K --why W` | frees a reservation: `not-sent`, `refused` by the provider without charge, or `reconciled` by a person who checked the bill |
| `well status --budget B` | shows the month's spent, held and cap, and the day's and week's spent and limit |
| `well breaches` | lists every month whose settled spend passed its cap; it must stay empty |

`--key` is the sha256 of the request's canonical form, which the client computes. An amount is a plain decimal with at most six places, from 0 to 1,000,000. A reserve refused names the limit it missed: `cap`, `cap-week`, `cap-day`, or `unsettled` for a request still open. Exit codes are 0 allowed, 1 refused, 2 a usage error and 3 a fault, such as a ledger folder that cannot be read. `--dir` names another ledger folder.

## Secrets

`well run` gives one paid call its secret. It reserves the estimate, reads the secret from the macOS Keychain only if the reservation is allowed, and starts the command with the secret in one environment variable:

```sh
well run --budget judge --tool my-tool --key "$key" --estimate 0.02 \
  --secret api.example.com/judge --env EXAMPLE_API_KEY -- my-tool call
```

The command writes what it was charged, such as `0.018`, to the file named in `WELL_CHARGE`, or `not-sent` or `refused`, and well settles or releases. A command that writes nothing leaves the reservation open, because the call may have been charged.

`well key set <service/account>` stores a generated secret, and `well key put <service/account>` stores one a provider issued, read from standard input with echo off. Neither ever takes a secret as an argument, prints one, or replaces one that exists.

This is a convention between cooperating programs, not a lock: any program running as the same user can read a Keychain item well stored.

## Use the library

A TypeScript client may carry `src/ledger.ts` and call it around each paid call:

```ts
import { appendEvent } from "./ledger.ts";

const held = appendEvent({ dir, budget: "judge", tool: "my-tool", event: "reserve", key, usd: estimate, at: new Date().toISOString() });
if (!held.ok) throw new Error(`refused: ${held.reason}`);
// make the call, then
appendEvent({ dir, budget: "judge", tool: "my-tool", event: "settle", key, usd: charged, at: new Date().toISOString() });
```

The rule lives in a shared test vector, copied here as `test/fixtures/ledger-vector.json`. A client in another language passes the same vector.

## Develop

```sh
npm ci
npm run check
```

`docs/architecture.md` holds the design and every decision with the alternative turned down. `docs/engineering.md` holds the testing doctrine.

## Name

A well is the one place a village draws its water from. Every program that spends draws from the same one here.

## Support

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/jahala)

## License

MIT
