// WS-21 L3.7: `winter daemon run` treats Migration C's typed refusals exactly like Migration B's — a
// message and exit 1, never a stack (a launchd crash loop otherwise).
import { describe, expect, test } from "bun:test";
import { MigrationCRefused, MigrationRefused } from "@yanlinglabs/winter-core";
import { migrationRefusalMessage } from "../src/daemon-boot-refusal";

describe("migrationRefusalMessage", () => {
  test("Migration B's and Migration C's refusals are operator messages", () => {
    expect(migrationRefusalMessage(new MigrationRefused("home_half_migrated", "b says"))).toBe("b says");
    for (const code of ["sdk_home_migration_required", "sdk_home_migration_refused", "sdk_home_half_migrated"] as const) {
      expect(migrationRefusalMessage(new MigrationCRefused(code, `c says ${code}`))).toBe(`c says ${code}`);
    }
  });
  test("anything else is not", () => {
    expect(migrationRefusalMessage(new Error("boom"))).toBeUndefined();
    expect(migrationRefusalMessage("nope")).toBeUndefined();
  });
});
