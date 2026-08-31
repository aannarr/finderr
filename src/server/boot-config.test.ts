/**
 * The boot message may name only remedies that work.
 *
 * `FINDERR_INDEX_REFRESH_ON_BOOT` was declared in `config.ts`, defaulted to `true`, mapped
 * from ENV -- and read by nothing. The boot message told a first-time operator to set it,
 * which did nothing, so they restarted into the identical crash loop. `docker compose exec`
 * could not rescue them either: the container was restarting, and the thing that would stop
 * it restarting was the command being attempted.
 *
 * Two halves, and the grep is the one that would have caught the original bug. It is a
 * source-text assertion rather than a behavioural one on purpose -- the defect was the
 * ABSENCE of a reader, and absence is not observable from behaviour that never ran.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../lib/config";

const root = join(import.meta.dir, "..", "..");
const serverSource = readFileSync(join(root, "src", "server", "index.ts"), "utf8");

describe("refreshOnBoot", () => {
  test("something outside config.ts actually reads it", () => {
    // The whole bug, in one assertion: a config key nothing consumes is a lie told to
    // whoever reads the boot message.
    expect(serverSource).toContain("cfg.index.refreshOnBoot");
  });

  test("is still a real config key with an ENV mapping", () => {
    expect(typeof loadConfig().index.refreshOnBoot).toBe("boolean");
  });

  test("the boot message offers it as the thing that builds an index", () => {
    // If the remedy is ever unwired again, this pins the message to the truth: the flag is
    // described by what it does, not as a mysterious incantation to set and restart.
    expect(serverSource).toContain("FINDERR_INDEX_REFRESH_ON_BOOT is off");
    expect(serverSource).toContain("which builds one on boot");
  });

  test("the flag being OFF is what makes a missing index fatal", () => {
    // The exit still exists -- an operator who has said "do not build" and has no index is
    // in a state the server cannot serve from, and should be told rather than left up.
    expect(serverSource).toMatch(/indexMissingAtBoot && !cfg\.index\.refreshOnBoot/);
    expect(serverSource).toContain("process.exit(1)");
  });
});
