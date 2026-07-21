import type { ApprovalPolicy } from "@norma/protocol";

/** The shift+tab approval-policy cycle order (SP-policies): `plan` (most restrictive — you must
 *  approve a plan before anything mutates) → `bypass` (least — auto-approve everything); the cycler
 *  wraps. Its OWN tiny module (zero runtime deps — only a type import) so BOTH the Ink footer/app
 *  (`app.tsx`) AND the raw `main.ts` cycler import ONE source and can never drift — without forcing
 *  `main.ts`'s light/legacy/one-shot path to eagerly load `app.tsx`'s whole Ink module graph (which
 *  a direct `import … from "./app"` would). Pinned by `test/policy-order.test.ts`. */
export const POLICY_ORDER: ApprovalPolicy[] = ["plan", "dont-ask", "ask", "accept-edits", "auto", "bypass"];
