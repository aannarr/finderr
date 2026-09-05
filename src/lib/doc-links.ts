/**
 * DOES A LINK FROM ONE TRACKED DOCUMENT LAND ON SOMETHING THAT EXISTS -- the file half,
 * and a heading inside it when the link names one.
 *
 * `doc-anchors.ts` answers this WITHIN a file: a renamed heading breaks `](#speed)` in the
 * same document. One file over, the same rename breaks `](TUNING.md#speed)` and nothing
 * sees it, and neither does anything see `](guides/typo.md)` at all. This is that floor.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK, so the boundaries have one written owner each:
 *
 *   - `http(s)://` and every other scheme (`mailto:`, `tel:`). Resolving those means hitting
 *     the network, and a gate that depends on somebody else's uptime goes red for reasons
 *     that have nothing to do with the commit under test.
 *   - A bare `#fragment`. `doc-anchors.ts` owns intra-document anchors.
 *   - A link into a private directory. `public-doc-links.test.ts` owns those, and such a
 *     link is ALSO a path that is not tracked -- reporting it here too would put two red
 *     tests on one defect, which teaches a reader to skim both.
 *
 * A path resolves relative to the LINKING DOCUMENT, not the repo root, which is what
 * `src/plugins/README.md` -> `../../ADDONS.md` depends on. A leading `/` is read as
 * repo-root-relative.
 *
 * The tree is passed in rather than read here: the fixture that proves the detector fires
 * is a two-entry map, and it would be a broken-link corpus on disk otherwise.
 */

import { posix } from "node:path";
import { type DocLink, documentLinks, headingTargets } from "./doc-anchors";
import { PRIVATE_DIR_PATTERN, readTrackedMarkdown, trackedFiles } from "./tracked-markdown";

/** The corpus a link is resolved against: every tracked path, and the markdown ones read. */
export type DocTree = { files: ReadonlySet<string>; markdown: ReadonlyMap<string, string> };

/** Why a link is broken, in the words the failure is reported with. */
export type BrokenReason = "no such file" | "no such heading";

/** One link that does not land, named where a reader can go and look at it. */
export type BrokenLink = { file: string; line: number; target: string; reason: BrokenReason };

const PRIVATE_DIR_LINK = new RegExp(`^[./]*${PRIVATE_DIR_PATTERN}`);
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** This repo as a `DocTree`: what is tracked, and every tracked document read. */
export async function trackedTree(): Promise<DocTree> {
  const docs = await readTrackedMarkdown();
  return { files: new Set(trackedFiles()), markdown: new Map(docs.map(({ file, text }) => [file, text])) };
}

/** Every link in `tree`'s documents that points at a file or heading the tree does not have. */
export function brokenLinks(tree: DocTree): BrokenLink[] {
  const broken: BrokenLink[] = [];
  for (const [file, text] of tree.markdown) {
    for (const link of resolvableLinks(text)) {
      const target = resolveFrom(file, link.path);
      const reason = missing(tree, target, link.anchor);
      if (reason) broken.push({ file, line: link.line, target: link.path + link.anchor, reason });
    }
  }
  return broken;
}

/**
 * The links this module is responsible for: the ones naming a path inside the repo. The
 * module docstring says what each exclusion belongs to instead.
 */
export function resolvableLinks(markdown: string): DocLink[] {
  return documentLinks(markdown).filter(
    ({ path }) =>
      path !== "" && !URL_SCHEME.test(path) && !path.startsWith("//") && !PRIVATE_DIR_LINK.test(path),
  );
}

/** A link's path as a repo-relative path, resolved from the document that carries it. */
function resolveFrom(file: string, path: string): string {
  return posix.normalize(path.startsWith("/") ? path.slice(1) : posix.join(posix.dirname(file), path));
}

/** What is missing about `target`, or null when the link lands. */
function missing(tree: DocTree, target: string, anchor: string): BrokenReason | null {
  if (target.endsWith("/")) return hasDirectory(tree, target) ? null : "no such file";
  if (!tree.files.has(target)) return "no such file";
  const targetText = tree.markdown.get(target);
  // A fragment is only checkable against markdown we parsed. `](src/lib/arr.ts#L20)` names a
  // line of source, which is GitHub's rendering rather than anything in the file.
  if (!anchor || targetText === undefined) return null;
  return headingTargets(targetText).has(anchor) ? null : "no such heading";
}

/** A directory exists when the tree tracks a file inside it. Git has no empty directories. */
function hasDirectory(tree: DocTree, target: string): boolean {
  for (const file of tree.files) if (file.startsWith(target)) return true;
  return false;
}
