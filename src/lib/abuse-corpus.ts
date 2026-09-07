/**
 * The hostile inputs, in ONE place, so every suite that should be testing them shares one
 * vocabulary and a new attack is added once.
 *
 * > [!IMPORTANT] THIS IS A SOURCE FILE, NOT A TEST FILE, AND THAT IS THE POINT
 * > It started life as a `const` inside `input-guards.test.ts`. A fixture that lives in a
 * > test file can only be imported by other test files, which quietly means the corpus is
 * > available to whoever already thought to look for it -- and the whole ambition here is
 * > that somebody writing a NEW route reaches for this without knowing it exists, because
 * > `abuse.test.ts` walks it over their code automatically.
 *
 * **Every interesting character is INVISIBLE, so none of them is written as itself.** A
 * fixture containing a literal U+202E is a line no reviewer can read and no diff can show
 * -- and a fixture that silently lost its one interesting character goes on passing while
 * testing nothing, which is precisely the failure mode this file exists to catch elsewhere.
 * Naming the code point is the documentation.
 *
 * **ADD TO THIS RATHER THAN WRITING A NEW ONE.** A second corpus is a second thing to keep
 * current, and the one nobody updates is always the one a reader happens to open.
 */

const cp = (...codes: number[]) => String.fromCodePoint(...codes);

/** NUL. Stored by SQLite, truncated at by anything that speaks C. */
export const NUL = cp(0x00);
/** ESC. Executed as an ANSI sequence by whatever terminal reads the log line it lands in. */
export const ESC = cp(0x1b);
/** RIGHT-TO-LEFT OVERRIDE. The classic display spoof, and it works in every browser. */
export const RLO = cp(0x202e);
/** ZERO WIDTH SPACE. Two names that look identical and are different rows. */
export const ZWSP = cp(0x200b);
/** COMBINING ACUTE ACCENT. Stacked, this is a rendering attack. */
export const ACUTE = cp(0x0301);
/** SOFT HYPHEN. Ordinary in text pasted out of a word processor, and deliberately KEPT. */
export const SHY = cp(0xad);

/**
 * Hostile strings by NAME, so a failure says which attack got through rather than printing
 * an unreadable value.
 *
 * The names are stable: a test that reports `rlo` failing is one somebody can act on.
 */
export const HOSTILE: Readonly<Record<string, string>> = {
  /**
   * The 22 KB, 3,200-token query that measured 26,631 ms against the real index on
   * 2026-09-07. The single most expensive string anybody has found.
   */
  longQuery: Array.from({ length: 3200 }, () => '"a* OR').join(" "),
  /** The same shape, short enough that a character cap alone would admit it. */
  manyTokens: Array.from({ length: 64 }, () => "ab").join(" "),
  /** Long, but ONE token -- linear rather than quadratic, and a useful control. */
  oneLongToken: "z".repeat(8_000),
  nul: `good${NUL}name`,
  ansiEscape: `name${ESC}[2Jcleared`,
  rlo: `admin${RLO}gpj.exe`,
  zeroWidth: `a${ZWSP}d${ZWSP}m${ZWSP}i${ZWSP}n`,
  invisibleOnly: ZWSP.repeat(3),
  zalgo: `e${ACUTE.repeat(60)}`,
  /** Six UTF-16 units, three code points -- the case a naive length check charges double. */
  astral: "\u{1f3ac}\u{1f3ac}\u{1f3ac}",
  /** Every FTS5 operator at once. `normalize` should leave none of them standing. */
  ftsOperators: '" * : ^ NOT AND OR NEAR( ) -',
  /** SQL, which is only ever a string here -- every query in this repo is parameterized. */
  sqlish: "'; drop table title; --",
  /** A path traversal, for anything that ever builds a filesystem path from a value. */
  traversal: "../../../etc/passwd",
  /** A script tag, for anything that reaches the DOM. */
  script: "<script>alert(1)</script>",
  /** A `javascript:` URL, which `externalHref` already refuses and must keep refusing. */
  jsUrl: "javascript:alert(1)",
  /** A protocol-relative URL -- an absolute one in disguise, which `localImageUrl` drops. */
  protocolRelative: "//evil.example/x.png",
  /** Deeply nested percent-encoding, for anything that decodes more than once. */
  doubleEncoded: "%252e%252e%252f%252e%252e%252f",
  /** An empty string, which is a value somebody sent and not an absent one. */
  empty: "",
  /** Whitespace only -- empty after trimming, and a different thing before it. */
  blank: "   \t  ",
} as const;

/**
 * Values that are not strings at all.
 *
 * A guard that only ever sees strings has never been asked the question every JSON body
 * poses: what if this field is a number, or null, or an object shaped like a string?
 */
export const NON_STRINGS: readonly unknown[] = [
  42,
  0,
  -1,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  null,
  undefined,
  true,
  false,
  {},
  [],
  { toString: () => "not a string" },
  ["a", "b"],
];

/** Every hostile string, as `[name, value]`, for a `test.each`-style walk. */
export const HOSTILE_CASES: readonly [string, string][] = Object.entries(HOSTILE);

/**
 * What must never appear in text this application stores or renders.
 *
 * THE CONTRACT, kept apart from the implementation that satisfies it. `sanitizeText` has its
 * own regex in `input-guards.ts`; this is the independent statement of what that regex is
 * FOR, so rewriting it cannot quietly narrow the rule -- the suite would go red rather than
 * agreeing with itself. Two copies of one pattern is normally the bug; here the second copy
 * is the specification and the duplication is the point.
 *
 * Built with `new RegExp` from escapes rather than written as literals, for the reason this
 * whole file exists: a character class of invisible characters is a line nobody can review.
 */
export const FORBIDDEN_PATTERNS: readonly { name: string; re: RegExp }[] = [
  // biome-ignore lint/complexity/useRegexLiterals: a literal would contain the invisible characters themselves
  { name: "C0 controls", re: new RegExp("[\\u0000-\\u001F]", "u") },
  // biome-ignore lint/complexity/useRegexLiterals: as above
  { name: "C1 controls", re: new RegExp("[\\u007F-\\u009F]", "u") },
  // biome-ignore lint/complexity/useRegexLiterals: as above
  { name: "bidi overrides", re: new RegExp("[\\u202A-\\u202E\\u2066-\\u2069]", "u") },
  // biome-ignore lint/complexity/useRegexLiterals: as above
  { name: "zero-width", re: new RegExp("[\\u200B-\\u200F\\u2060-\\u2064\\uFEFF]", "u") },
];
