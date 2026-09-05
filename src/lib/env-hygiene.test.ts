/**
 * `.env` must not define a `FINDERR_*` key, and the reason is not tidiness.
 *
 * > [!CAUTION] A `FINDERR_` key in `.env` silently configures every host `bun` process
 * > Bun auto-loads `.env` from the working directory -- no import, no flag, no opt-in --
 * > and `loadConfig()` reads `FINDERR_*` straight out of `process.env`. So a variable put
 * > in `.env` for `docker-compose.yml` to map is NOT inert on the host: it configures the
 * > app for `bun test`, `bun run dev` and every script in `package.json`.
 * >
 * > Measured 2026-08-31, and this test exists because of it: moving the arr URLs into
 * > `.env` as `FINDERR_RADARR_URL` took the suite from 770 pass to **206 fail**. The API
 * > keys in `.env` are named `RADARR_API_KEY` (compose maps them to `FINDERR_RADARR_API_KEY`),
 * > so `loadConfig()` saw a configured Radarr with no key and threw
 * > `invalid configuration: radarr is configured but FINDERR_RADARR_API_KEY is missing`.
 * > Every test that builds a config died on it.
 * >
 * > The container was never affected, which is what makes this worth pinning: compose
 * > supplies the mapped keys, so the failure appears ONLY on the host, only in the gate,
 * > and looks nothing like its cause.
 *
 * The convention that avoids it: `.env` uses UNPREFIXED names (`RADARR_URL`,
 * `AUTH_RP_ID`) and `docker-compose.yml` maps each one onto its `FINDERR_` variable.
 * That is what `RADARR_API_KEY` already did; this test makes it the rule rather than
 * an accident of which key happened to be written first.
 *
 * Skipped when there is no `.env`, which is the case in CI and in a fresh clone.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;
const ENV_PATH = `${ROOT}.env`;

/** Keys assigned in a dotenv file, ignoring comments, blanks and `export` prefixes. */
function assignedKeys(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

describe("dotenv hygiene", () => {
  test("the parser reads assignments and ignores comments", () => {
    expect(
      assignedKeys("# FINDERR_COMMENTED=1\n\nRADARR_URL=http://radarr:7878\nexport A_B=2\nnot a line\n"),
    ).toEqual(["RADARR_URL", "A_B"]);
  });

  test.skipIf(!existsSync(ENV_PATH))(
    ".env defines no FINDERR_ key -- bun auto-loads it into every host process",
    () => {
      const offenders = assignedKeys(readFileSync(ENV_PATH, "utf8")).filter((k) => k.startsWith("FINDERR_"));
      expect(offenders).toEqual([]);
    },
  );
});

/**
 * The model list has ONE owner and it is `DEFAULTS.ai.models` in `src/lib/config.ts`.
 *
 * > [!CAUTION] A compose fallback beats the code default and looks exactly like a choice
 * > Found on the live NAS 2026-09-05. `docker-compose.yml` read
 * > `FINDERR_AI_MODELS: ${AI_MODELS:-z-ai/glm-5.3-flash}`, so every container was handed a
 * > pinned model whether or not an operator had asked for one -- and moving the default in
 * > `config.ts` therefore changed nothing anywhere it was deployed. Nothing logged and
 * > nothing disagreed: the env var was simply always set.
 *
 * The other fallbacks in that file are deployment SHAPE and are welcome. This one is a
 * BENCHMARK RESULT, which moves whenever somebody re-runs `bun run agent:eval`, so a second
 * copy is a second thing to update in lockstep and the copy nobody updates is the one that
 * wins. Empty is the correct fallback: `envStr` maps `""` to `undefined`.
 */
describe("compose does not pin the assistant's model", () => {
  const COMPOSE = readFileSync(`${ROOT}docker-compose.yml`, "utf8");

  test("FINDERR_AI_MODELS falls through to the code default", () => {
    const line = COMPOSE.split("\n").find((l) => l.includes("FINDERR_AI_MODELS:"));
    expect(line).toBeDefined();
    // Built rather than written out: a bare "${AI_MODELS:-}" in a normal string trips
    // biome's noTemplateCurlyInString, and escaping it would obscure what is asserted.
    const EMPTY_FALLBACK = ["FINDERR_AI_MODELS: $", "{AI_MODELS:-}"].join("");
    expect(line?.trim()).toBe(EMPTY_FALLBACK);
  });

  test("no model id is hardcoded anywhere in the compose file", () => {
    // A provider-qualified id -- `vendor/model`, which is the only shape OpenRouter takes.
    const ids = COMPOSE.split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .flatMap((l) => [...l.matchAll(/\b(?:openai|anthropic|google|meta|z-ai|mistralai)\/[a-z0-9.-]+/gi)])
      .map((m) => m[0]);
    expect(ids).toEqual([]);
  });
});
