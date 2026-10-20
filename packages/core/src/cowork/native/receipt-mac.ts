import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/*
 * Authenticity of the launcher's RETAINED stop receipts (owner ruling 2026-10-18). The launcher's receipt store is a same-user writable file, so a
 * retained Class A receipt counts as evidence only if its MAC verifies under a per-installation secret key AND both D1 guard probes pass.
 *
 *  - The key is 32 random bytes in the daemon's Keychain service (account `cowork-native-receipt-mac-v1`), created on first need. It lives nowhere
 *    else: it is handed to the launcher once, in the L1 `begin` line (an authenticated socketpair, so it never touches disk), and the launcher keeps
 *    it in memory only.
 *  - The MAC is HMAC-SHA256 over the receipt's canonical JSON text with the `mac` key left out (protocol.ts builds that text), base64 on the wire.
 *  - A missing, unreadable or malformed key at verify time makes the receipt Class B: nothing releases, the owner's Recover is the way out. There is no
 *    rotation API. Losing or replacing the key turns every retained receipt into Class B for the same reason.
 *
 * Nothing here logs, and no error carries key material: every error is a fixed code. The key is a class with private storage whose JSON, string and
 * inspect forms are all "[redacted]"; the one door to the base64 text is `reveal()`, called by the L1 serializer and nowhere else.
 */

export const COWORK_NATIVE_RECEIPT_KEY_BYTES = 32;
export const COWORK_NATIVE_RECEIPT_KEY_ACCOUNT = "cowork-native-receipt-mac-v1";
const BASE64_32 = /^[A-Za-z0-9+/]{43}=$/;

/** True for the canonical padded base64 spelling of exactly 32 bytes (44 characters). */
export function isCanonicalBase64Of32Bytes(text: unknown): text is string {
  return typeof text === "string" && BASE64_32.test(text) && Buffer.from(text, "base64").length === COWORK_NATIVE_RECEIPT_KEY_BYTES && Buffer.from(text, "base64").toString("base64") === text;
}

const REDACTED = "[redacted]";
export class CoworkNativeReceiptKey {
  readonly #bytes: Uint8Array;
  private constructor(bytes: Uint8Array) { this.#bytes = bytes; }
  static fromBytes(bytes: Uint8Array): CoworkNativeReceiptKey {
    if (!(bytes instanceof Uint8Array) || bytes.length !== COWORK_NATIVE_RECEIPT_KEY_BYTES) throw new RangeError("receipt_key_length");
    return new CoworkNativeReceiptKey(Uint8Array.from(bytes));
  }
  /** Null for anything but the canonical base64 of exactly 32 bytes. */
  static fromBase64(text: unknown): CoworkNativeReceiptKey | null {
    return isCanonicalBase64Of32Bytes(text) ? new CoworkNativeReceiptKey(Uint8Array.from(Buffer.from(text, "base64"))) : null;
  }
  static generate(): CoworkNativeReceiptKey { return new CoworkNativeReceiptKey(Uint8Array.from(randomBytes(COWORK_NATIVE_RECEIPT_KEY_BYTES))); }
  /** The base64 text, for the L1 `begin` line and the Keychain slot only. */
  reveal(): string { return Buffer.from(this.#bytes).toString("base64"); }
  /** HMAC-SHA256 of `input`, 32 raw bytes. */
  hmac(input: string | Uint8Array): Buffer { return createHmac("sha256", this.#bytes).update(input).digest(); }
  equals(other: CoworkNativeReceiptKey | null): boolean { return other !== null && timingSafeEqual(Buffer.from(this.#bytes), Buffer.from(other.#bytes)); }
  toJSON(): string { return REDACTED; }
  toString(): string { return REDACTED; }
  [Symbol.for("nodejs.util.inspect.custom")](): string { return REDACTED; }
}

/** Base64 MAC of `input` under `key`. */
export function computeCoworkNativeReceiptMac(key: CoworkNativeReceiptKey, input: string | Uint8Array): string { return key.hmac(input).toString("base64"); }

/** Constant-time verification. False for a missing key, a MAC that is not the canonical base64 of 32 bytes, and a mismatch. Never throws. */
export function verifyCoworkNativeReceiptMac(key: CoworkNativeReceiptKey | null, input: string | Uint8Array, mac: unknown): boolean {
  try {
    if (!(key instanceof CoworkNativeReceiptKey) || !isCanonicalBase64Of32Bytes(mac)) return false;
    return timingSafeEqual(key.hmac(input), Buffer.from(mac, "base64"));
  } catch { return false; }
}

/** The two Keychain operations the key store needs (the daemon's `SecretStore` satisfies it). */
export interface CoworkNativeSecretSlot {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
}
export type CoworkNativeReceiptKeyFailure = "receipt_key_unreadable" | "receipt_key_unwritable";
export class CoworkNativeReceiptKeyError extends Error {
  constructor(readonly code: CoworkNativeReceiptKeyFailure) { super(code); this.name = "CoworkNativeReceiptKeyError"; }
}

/** The per-installation key in the Keychain slot. `read` never throws and never creates; `ensure` creates on first need. */
export class CoworkNativeReceiptKeyStore {
  private pending: Promise<CoworkNativeReceiptKey> | null = null;
  constructor(private readonly slot: CoworkNativeSecretSlot, private readonly account: string = COWORK_NATIVE_RECEIPT_KEY_ACCOUNT) {}

  /** The stored key, or null when it is missing, malformed or the Keychain cannot be read. Used where nothing may be created (boot reconcile). */
  async read(): Promise<CoworkNativeReceiptKey | null> {
    try { return CoworkNativeReceiptKey.fromBase64(await this.slot.get(this.account)); } catch { return null; }
  }

  /** The stored key, created (32 random bytes) if the slot is empty or holds something that is not a key. A slot that cannot be READ is an error,
   * never a reason to overwrite it: a locked or denied Keychain must not replace a good key. Single-flight. */
  ensure(): Promise<CoworkNativeReceiptKey> {
    this.pending ??= this.create().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async create(): Promise<CoworkNativeReceiptKey> {
    let stored: string | null;
    try { stored = await this.slot.get(this.account); } catch { throw new CoworkNativeReceiptKeyError("receipt_key_unreadable"); }
    const existing = CoworkNativeReceiptKey.fromBase64(stored);
    if (existing !== null) return existing;
    // One fixed line, never the value: a replaced key makes every receipt signed under the old one Class B, and a person debugging that should be able to see why.
    if (stored !== null) console.error("cowork: receipt key replaced (malformed)");
    // Empty, or a value that is not a canonical 32-byte key (corruption, or an older format): replace it. Receipts signed under the lost value are
    // Class B from now on, which is where an unreadable key would have left them anyway.
    const fresh = CoworkNativeReceiptKey.generate();
    try { await this.slot.set(this.account, fresh.reveal()); } catch { throw new CoworkNativeReceiptKeyError("receipt_key_unwritable"); }
    const confirmed = await this.read();
    if (confirmed === null || !confirmed.equals(fresh)) throw new CoworkNativeReceiptKeyError("receipt_key_unwritable");
    return confirmed;
  }
}
