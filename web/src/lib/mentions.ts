/**
 * Turning `Name [tt0903747]` in an answer into something clickable.
 *
 * The server tells the model to bracket an id after the first mention of anything it names,
 * and returns every id it could RESOLVE (`mentions` on the response). This splits the prose
 * on those brackets so the renderer can draw a link where one is warranted and clean text
 * where it is not.
 *
 * > [!IMPORTANT] THE DEAD-END RULE, AND THE BRACKETS ARE NEVER SHOWN EITHER WAY
 * > A model can emit a well-formed `tt99999999` that has never existed. An unresolved
 * > bracket is therefore REMOVED and the name left as plain text -- never rendered as a link
 * > (it would 404) and never left visible (it is punctuation the reader was not meant to
 * > see). "Navigable does not outrank honest" is the project's own wording for this.
 *
 * > [!CAUTION] THE LABEL COMES FROM OUR INDEX, NOT FROM THE MODEL'S SENTENCE
 * > `linkText` prefers the resolved `label`. A model that writes "The Sopranos [tt0903747]"
 * > is wrong -- that id is Breaking Bad -- and echoing its wording would launder the mistake
 * > into something that looks verified. Showing our label makes the disagreement visible
 * > instead of hiding it.
 *
 * Pure and DOM-free so the rule is tested as a function rather than through a component.
 */

/** One piece of a rendered answer: prose, or a resolved link. */
export type AnswerPart =
  | { kind: "text"; text: string }
  | { kind: "link"; id: string; label: string; path: string; entity: "title" | "person" };

/** What the server resolved. Mirrors `Mention` in `src/lib/agent/mentions.ts`. */
export interface ResolvedMention {
  id: string;
  kind: "title" | "person";
  label: string;
  path: string;
  year?: number | null;
}

/**
 * Just the bracketed id. The NAME is found afterwards, using our own label.
 *
 * An earlier version tried to capture the name in this pattern and could not: a lazy
 * `([^.!?\n]{1,80}?)\s*\[id\]` still starts matching at the earliest position the engine
 * can, so "You should watch Furious [tt…]" captured the whole clause and swallowed four
 * words of prose into the link. The extent of a name is genuinely not recoverable from the
 * text alone -- "watch Furious" and "Furious" are equally plausible readings.
 *
 * So the name is found by looking for OUR label immediately before the bracket, which is
 * both reliable and the behaviour we want anyway: see `splitMentions`.
 */
const MENTION = /\[((?:tt|nm)\d+)\]/g;

/** Trailing whitespace-insensitive check that `text` ends with `label`, case-folded. */
function endsWithLabel(text: string, label: string): number | null {
  const trimmed = text.replace(/\s+$/, "");
  if (trimmed.length < label.length) return null;
  const tail = trimmed.slice(-label.length);
  return tail.toLowerCase() === label.toLowerCase() ? trimmed.length - label.length : null;
}

/**
 * Split an answer into text and links.
 *
 * `resolved` is keyed by id; anything not in it is a miss and its brackets are dropped.
 *
 * On a HIT there are two shapes, and the second is not a failure:
 *
 * - The prose ends with OUR label ("…watch Furious [tt36303968]"), so the label is consumed
 *   and becomes the link text. This is the ordinary case and what the prompt asks for.
 * - It does not -- the model wrote a different name, or an inflected one. The bracket is
 *   replaced by the link and the model's own wording is LEFT STANDING as prose beside it.
 *   That is deliberate: silently deleting words the model wrote would hide a disagreement
 *   about what an id refers to, and this way a reader sees "The Sopranos Furious" and knows
 *   something is off rather than being shown a confident, wrong link.
 */
export function splitMentions(answer: string, resolved: readonly ResolvedMention[]): AnswerPart[] {
  if (!answer) return [];
  const byId = new Map(resolved.map((m) => [m.id, m]));
  const parts: AnswerPart[] = [];
  const pushText = (text: string): void => {
    if (!text) return;
    const last = parts[parts.length - 1];
    // Merge adjacent text so a dropped bracket does not leave the renderer two fragments of
    // one sentence -- which matters for markdown, where a split can break an inline span.
    if (last && last.kind === "text") last.text += text;
    else parts.push({ kind: "text", text });
  };

  let cursor = 0;
  MENTION.lastIndex = 0;
  let match: RegExpExecArray | null = MENTION.exec(answer);
  while (match !== null) {
    const id = match[1] as string;
    const hit = byId.get(id);
    const before = answer.slice(cursor, match.index);

    if (!hit) {
      // A miss: keep the prose, drop the brackets. Never a link built from an id's shape.
      pushText(before.replace(/\s+$/, ""));
    } else {
      const cut = endsWithLabel(before, hit.label);
      if (cut === null) {
        pushText(before.replace(/\s+$/, " "));
      } else {
        pushText(before.slice(0, cut));
      }
      parts.push({ kind: "link", id: hit.id, label: hit.label, path: hit.path, entity: hit.kind });
    }
    cursor = match.index + match[0].length;
    match = MENTION.exec(answer);
  }

  pushText(answer.slice(cursor));
  return parts;
}

/**
 * The answer with every bracket removed and nothing linked.
 *
 * For anywhere a link cannot go -- a localStorage preview, an accessible label, a title
 * attribute. Sharing one implementation with the splitter means the two cannot disagree
 * about what the reader is supposed to see.
 */
export function stripMentions(answer: string): string {
  return answer
    .replace(MENTION, "")
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}
