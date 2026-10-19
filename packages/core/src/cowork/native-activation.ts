import { homedir } from "node:os";
import type { CoworkRepository } from "./repository";
import type { RuntimeStateDb } from "../runtime-state/db";
import { createCoworkNativeProductionEnvironment } from "./host-env/environment";
import type { CoworkNativeEnvironment } from "./native-wiring";

/*
 * THE ACTIVATION SEAM for the native worker's production environment (N2 S7B part 1).
 *
 * `daemon.ts` asks this one function for the environment the native wiring builds its host from. Today it answers `undefined`, so the wiring is inert:
 * nothing in the daemon constructs, injects or reads the production environment, and a Cowork start refuses before it gets anywhere near it. The flip is the
 * single constant below, `COWORK_NATIVE_ENVIRONMENT_ACTIVATED`, and it changes on the owner's word only (the DOOR lane's `coworkSessions` switch is the other half).
 * Pinned by the anti-wiring test ("the production environment is built only through the activation seam, and the seam is off"): the seam answers `undefined`, only this file imports the builder, and the daemon calls this function lazily.
 *
 * It takes a thunk so that even the inputs (the environment, the real home directory) are not read while the seam is off.
 */
const COWORK_NATIVE_ENVIRONMENT_ACTIVATED: boolean = false;

export interface CoworkNativeActivationContext {
  readonly home: string; readonly db: RuntimeStateDb; readonly records: CoworkRepository;
  readonly env: Readonly<Record<string, string | undefined>>;
}
export function coworkNativeProductionEnvironment(context: () => CoworkNativeActivationContext): (() => CoworkNativeEnvironment) | undefined {
  if (!COWORK_NATIVE_ENVIRONMENT_ACTIVATED) return undefined;
  const { home, db, records, env } = context();
  return () => createCoworkNativeProductionEnvironment({ home, db, records, coordination: { env, homeDirectory: homedir() }, executablePath: process.execPath });
}
