import { loadCatalog } from "@yanlinglabs/winter-provider-catalog";
import type { CredentialPresence } from "@yanlinglabs/winter-runtime-sdk";
import type { SyncConfigModel } from "@yanlinglabs/winter-protocol";
import { facingNameOf, type ModelTag } from "../runtime-sdk/model-tag";
import { effortVocabularyFor, imagesAcceptedBy, toolsRefusedFor } from "../runtime-sdk/provider-selection";
import { credentialPresentProbe } from "../runtime-sdk/keychain";

// Mirrors `ipc/sync.ts`'s own `effortsForModel` EXACTLY (never imported from there — `sync.ts`
// imports `pickerModels` from this module for `sync.config`'s own `models` field, and importing
// back would be a cycle). Both now read the SAME row rule (`effortVocabularyFor`,
// runtime-sdk/provider-selection.ts), so the two copies of the `"none"` prepend are the only thing
// duplicated and they can never disagree about what the catalog says.
function effortsForModel(tag: string): string[] {
  const efforts = effortVocabularyFor(tag) ?? [];
  return efforts.length > 0 ? ["none", ...efforts] : [];
}

/**
 * WS-20: the rows a picker (`sync.config`'s `models`, and any future Mac-side model picker) may
 * offer — one entry per (provider that holds a credential) × (row that provider serves), catalog
 * order throughout. `cc/*` never — it has no catalog row at all (a reserved, code-level prefix,
 * never a real provider id), so it can never be reached by this iteration to begin with.
 *
 * A provider with NO stored credential (the Console included, when its bearer slot is empty) is
 * EXCLUDED entirely — the app's "Add a key…" footer is a separate, `credential.list`-fed affordance,
 * not this list's job to represent an absence.
 *
 * The rule lives in ONE place (`credentialPresentProbe`, runtime-sdk/keychain.ts) and is shared with
 * `models.catalog`'s `credentialPresent`, so the two provider listings cannot disagree about which
 * providers a home is ready to use — and it reads the same `byProvider` the router admits a session's
 * row on, so a model offered here is one `session.create` accepts (the WS-23 live-gate fix: `console`
 * used to be answered by its on-disk profile here while the router saw no `console` credential at all).
 *
 * WS-24 (pickers lane, fix round 1): a row `toolsRefusedFor` (`runtime-sdk/provider-selection.ts`)
 * says would refuse a real turn's tools is EXCLUDED too — this is THE session picker, and a Winter
 * session of any mode always offers tools, so a session started on such a row could never work.
 * `toolsRefusedFor` is NOT "the catalog's `toolCalling` says `\"none\"`" — most `"none"` rows are the
 * catalog's fail-closed placeholder for a capability upstream never stated, and would work fine
 * today (see that function's own doc for the measured adapter behaviour and the ~470-row mistake its
 * first cut made). This is the ONE choke point every session picker reads through (`sync.config`'s
 * `models`, the Mac's `ComposerModelPanel`, the CLI's `winter model`, the TUI's `/model` — all read
 * `sync.config` and none re-filters), so filtering here is enough to hide these rows everywhere a
 * SESSION picks a model, with no per-client change. `models.catalog`
 * (`providers/model-catalog-wire.ts`) is a DIFFERENT listing on purpose and is left unfiltered — see
 * that module's own note on why.
 */
export function pickerModels(deps: { credentials: CredentialPresence; home: string }): SyncConfigModel[] {
  const catalog = loadCatalog();
  const credentialPresent = credentialPresentProbe(deps);
  const out: SyncConfigModel[] = [];
  for (const provider of catalog.providers) {
    if (!credentialPresent(provider.id)) continue;
    for (const row of catalog.models) {
      if (row.providerId !== provider.id) continue;
      // A vendor-retired row (`deprecated`, SDK 0.0.23) still resolves for a stored tag but is never offered.
      if (row.status === "blocked" || row.status === "deprecated") continue;
      // WS-24: a row a real turn would refuse tools on is never offered here either — see this
      // function's own doc, and `toolsRefusedFor`'s.
      if (toolsRefusedFor(row)) continue;
      const tag = row.key as ModelTag;
      out.push({
        id: tag,
        providerId: provider.id,
        displayName: row.displayName,
        ...(facingNameOf(tag) === undefined ? {} : { facingName: facingNameOf(tag)! }),
        efforts: effortsForModel(tag),
        supportsImages: imagesAcceptedBy(row),
      });
    }
  }
  return out;
}
