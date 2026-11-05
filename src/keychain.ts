// The Keychain: the only place well reads or stores a secret (docs/tend2/keys.tend2.html). Every
// call goes through /usr/bin/security, passed in as a Security function so a test can record what
// each call was given. A secret travels only on standard input, to store it, and on standard
// output, to read it; never in an argument, where any process could read it.
//
// A secret is stored by sending `add-generic-password ... -w <value>` on the standard input of
// `security -i`, then read back: piping a value into `security add-generic-password -w` exits 0 and
// stores an empty password.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

export interface Item {
  service: string;
  account: string;
}

export type Security = (args: readonly string[], input?: string) => { status: number | null; stdout: string };

/**
 * Runs /usr/bin/security by its full path, so nothing earlier on PATH can stand in for it. A
 * security that cannot start answers with no status, which every caller reads as a Keychain failure.
 */
export const systemSecurity: Security = (args, input) => {
  const ran = spawnSync("/usr/bin/security", [...args], { input: input ?? "", encoding: "utf8" });
  return { status: ran.error ? null : ran.status, stdout: ran.stdout ?? "" };
};

/** security's status when the item is not in the keychain. */
const NOT_FOUND = 44;

/** A name part safe on a `security -i` line: no space, quote or newline can end it early. */
const part = /^[A-Za-z0-9._@-]+$/;

/** `service/account`, or null when either part is empty or carries a character outside the set. */
export function parseItem(name: string): Item | null {
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [service = "", account = ""] = parts;
  return part.test(service) && part.test(account) ? { service, account } : null;
}

const where = (item: Item, keychain: string | undefined): string[] => ["-s", item.service, "-a", item.account, ...(keychain ? [keychain] : [])];

export type Read = { ok: true; value: string } | { ok: false; reason: "no-secret" | "empty-secret" | "keychain" };

/** Reads a secret at the moment it is needed. An empty one is refused. */
export function readSecret(item: Item, keychain: string | undefined, security: Security): Read {
  const found = security(["find-generic-password", "-w", ...where(item, keychain)]);
  if (found.status === NOT_FOUND) return { ok: false, reason: "no-secret" };
  if (found.status !== 0) return { ok: false, reason: "keychain" };
  const value = found.stdout.replace(/\n$/, "");
  return value === "" ? { ok: false, reason: "empty-secret" } : { ok: true, value };
}

export type Stored = { ok: true } | { ok: false; reason: "exists" | "unstorable" | "no-secret" | "empty-secret" | "mismatch" | "keychain" };

/**
 * A value safe to send on a `security -i` line as it is: printable ASCII with no space, quote or
 * backslash, which security's parser would read as the end of the value, and no newline, which
 * would start a second command. API keys a provider issues fit; anything else is refused.
 */
const storable = /^[!#-&(-[\]-~]+$/;

/**
 * Stores a secret and reads it back. An item that already exists is never replaced. A store that
 * reads back empty or different is removed and refused.
 */
export function putSecret(item: Item, value: string, keychain: string | undefined, security: Security): Stored {
  if (value === "") return { ok: false, reason: "empty-secret" };
  if (!storable.test(value)) return { ok: false, reason: "unstorable" };
  const exists = security(["find-generic-password", ...where(item, keychain)]);
  if (exists.status === 0) return { ok: false, reason: "exists" };
  if (exists.status !== NOT_FOUND) return { ok: false, reason: "keychain" };
  const stored = security(["-i"], `add-generic-password ${where(item, keychain).slice(0, 4).join(" ")} -w ${value}${keychain ? ` ${keychain}` : ""}\n`);
  if (stored.status !== 0) return { ok: false, reason: "keychain" };
  const read = readSecret(item, keychain, security);
  if (read.ok && read.value === value) return { ok: true };
  security(["delete-generic-password", ...where(item, keychain)]);
  return { ok: false, reason: read.ok ? "mismatch" : read.reason };
}

/** Generates a secret of 32 random bytes as hex and stores it. */
export function setSecret(item: Item, keychain: string | undefined, security: Security): Stored {
  return putSecret(item, randomBytes(32).toString("hex"), keychain, security);
}
