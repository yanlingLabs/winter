/**
 * 2026-09-19: the ONE live snapshot of "which providers can Winter's own background jobs actually run
 * on right now" — the object the wire (`settings.modelRoles`), the default-tag readers
 * (`settings.ts`'s `preferredInternalProviderFor`/`internalRoleDefaultTagFor`) and the actual
 * dispatcher (`internal-router.ts`) all read, so none of them can disagree.
 *
 * This is the generalisation of the anti-race property `createRebindableProvider`'s header describes.
 * That property was "the bookkeeping and the actually-bound backend must never disagree", and it was
 * achieved by making the bookkeeping READ the bound backend (`agentProvider.live().providerId`). With
 * one instance per credentialed provider there is no single "bound backend" to read, so the property
 * is achieved the other way round: there is exactly ONE mutable fact (`credentialed`), every consumer
 * derives from it synchronously, and it changes only inside `refresh()`.
 *
 * SYNCHRONOUS BY CONTRACT. Credential presence is a Keychain read; every settings reader that needs it
 * is pure and sync. So presence is CACHED, and the cache is only ever moved by `refresh()` — which the
 * daemon calls at boot (seeded from the probe `daemon.ts` already runs, so there is no cold-start
 * false negative) and awaits in `credential.set`/`credential.remove` before those RPCs return. This is
 * deliberately NOT the background-probe-on-read shape `advisor-reviewer.ts`'s `credentialPresenceCache`
 * uses: that one may under-report for one call after a write, which is tolerable for "is there a
 * reviewer" and is not tolerable for "did the key I just added take effect on the next call".
 *
 * ONE LOG LINE PER CHANGE, never per call: `refresh()` compares the new set against the old and
 * narrates only a difference (the same "one line per settings change, not a one-time transition" rule
 * `officialSubscriptionAuthFlagInert` follows).
 */
import type { SecretStore } from "../auth/secret-store";
import { INTERNAL_JOBS_LOGIN_HINT as LOGIN_HINT } from "./internal-login-hint";
import { credentialInventory, credentialPresenceFrom } from "../runtime-sdk/keychain";
import {
  internalEligibleProviderIds,
  internalProviderPreferenceOrder,
  preferredInternalProviderFor,
  type InternalProviderSnapshot,
  type Settings,
} from "../settings";

export interface InternalProviderView {
  /** Catalog-derived, immutable for the process — `settings.ts`'s own predicate, re-exposed so a
   *  consumer holding a view never needs a second import. */
  eligible(): ReadonlySet<string>;
  /** Eligible providers whose credential slot holds material as of the last `refresh()`. */
  credentialed(): ReadonlySet<string>;
  /** The snapshot value the pure settings readers take. */
  snapshot(): InternalProviderSnapshot;
  /** Which provider an internal role with no explicit pin follows — `undefined` means inert. */
  preferred(settings: Settings | null | undefined): string | undefined;
  /**
   * Bumps whenever `credentialed` changes. Consumers that CACHE something derived from this view (the
   * per-provider `Provider` instances in `internal-router.ts`) key their cache on it, so a credential
   * write cannot leave a live instance holding material that has since been replaced.
   */
  generation(): number;
  /**
   * When `credentialed` last CHANGED, as an ISO string. The synthetic role problems
   * (`ipc/server.ts`'s `settings.modelRoles`) are DERIVED, not recorded — stamping them with
   * `Date.now()` per read would make the Mac's Notes section flicker a new timestamp on every poll, so
   * they carry the moment the condition itself last moved.
   */
  changedAt(): string;
  /** The one-line human summary `daemon.ts` prints at boot and `refresh()` prints on a change — the
   *  SAME sentence, so the log never has two spellings of the same fact. */
  summary(): string;
  /** Re-probes the eligible slots and updates the snapshot. Never throws. */
  refresh(): Promise<void>;
}

export function createInternalProviderView(deps: {
  secrets: SecretStore;
  /** The boot probe `daemon.ts` already ran (`credentialPresenceFrom(secrets)`'s `byProvider` keys) —
   *  seeding from it is what makes the very first internal call after boot see the real answer. */
  seed?: ReadonlySet<string>;
  log?: (message: string) => void;
}): InternalProviderView {
  const eligible = internalEligibleProviderIds();
  const log = deps.log ?? ((m: string) => console.error(m));
  let credentialed: ReadonlySet<string> = new Set([...(deps.seed ?? [])].filter((id) => eligible.has(id)));
  let generation = 0;
  let changedAt = new Date().toISOString();
  let snapshot: InternalProviderSnapshot = { credentialed };

  const describe = (set: ReadonlySet<string>): string =>
    set.size === 0 ? "none" : internalProviderPreferenceOrder().filter((id) => set.has(id)).join(", ");
  const summaryOf = (set: ReadonlySet<string>): string =>
    set.size === 0
      ? `internal-provider: no provider Winter's own jobs can run on holds a credential — titles, the bash safety reviewer, the dreamer and the session cleaner are inert until one is stored (${LOGIN_HINT})`
      : `internal-provider: Winter's own jobs can run on ${describe(set)}`;

  const view: InternalProviderView = {
    eligible: () => eligible,
    credentialed: () => credentialed,
    snapshot: () => snapshot,
    preferred: (settings) => preferredInternalProviderFor(settings, snapshot),
    generation: () => generation,
    changedAt: () => changedAt,
    summary: () => summaryOf(credentialed),
    async refresh() {
      // Only the ELIGIBLE slots, never the whole ~150-row inventory: this runs on every credential
      // write and the rows for providers Winter's jobs can never use would be pure cost.
      const slots = credentialInventory().filter((s) => eligible.has(s.provider));
      let next: ReadonlySet<string>;
      try {
        const presence = await credentialPresenceFrom(deps.secrets, slots);
        next = new Set(Object.keys(presence.byProvider).filter((id) => eligible.has(id)));
      } catch (err) {
        // `credentialPresenceFrom` already swallows per-slot failures; a throw here would have to be
        // the store itself. Keep the last good answer rather than declaring every job inert.
        log(`internal-provider: credential probe failed (${err instanceof Error ? err.message : String(err)}) — keeping the previous set (${describe(credentialed)})`);
        return;
      }
      if (next.size === credentialed.size && [...next].every((id) => credentialed.has(id))) return;
      const before = credentialed;
      credentialed = next;
      snapshot = { credentialed };
      generation += 1;
      changedAt = new Date().toISOString();
      log(`${summaryOf(next)} (was ${describe(before)})`);
    },
  };
  return view;
}

/**
 * A view for a daemon with no real credential story — an injected `agentProvider` test double, or
 * `runtime-state/probe.ts`'s deliberately provider-less boot. `refresh()` is a no-op, so nothing here
 * ever touches a secret store.
 */
export function staticInternalProviderView(credentialed: Iterable<string> = []): InternalProviderView {
  const set: ReadonlySet<string> = new Set(credentialed);
  const snapshot: InternalProviderSnapshot = { credentialed: set };
  return {
    eligible: () => internalEligibleProviderIds(),
    credentialed: () => set,
    snapshot: () => snapshot,
    preferred: (settings) => preferredInternalProviderFor(settings, snapshot),
    generation: () => 0,
    changedAt: () => STATIC_CHANGED_AT,
    summary: () => (set.size === 0 ? "internal-provider: no credentialed provider (injected view)" : `internal-provider: Winter's own jobs can run on ${[...set].join(", ")} (injected view)`),
    refresh: async () => {},
  };
}

/** A fixed instant for the injected view — a derived problem read off a static view must not carry a
 *  timestamp that moves on every read (see `InternalProviderView.changedAt`). */
const STATIC_CHANGED_AT = new Date(0).toISOString();
