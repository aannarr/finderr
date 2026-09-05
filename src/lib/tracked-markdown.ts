/**
 * WHICH FILES ARE THE PUBLIC DOCUMENTS -- one owner, so every doc hygiene check sweeps
 * the same set.
 *
 * `git ls-files` rather than a hardcoded list or a glob: a document is public exactly when
 * it is tracked, which is the same question the pre-push scrub and the gitignore-link check
 * already ask. A hardcoded list is a second answer that goes stale the first time somebody
 * adds a doc and forgets to enrol it -- which is the failure these checks exist to catch.
 */

/** Repo root. This file lives at `src/lib/`, so two levels up. */
export const repoRoot = new URL("../../", import.meta.url).pathname;

/** Every tracked `.md` path, repo-relative. Gitignored docs may say what they like. */
export function trackedMarkdownFiles(): string[] {
  const ls = Bun.spawnSync(["git", "ls-files", "-z", "*.md"], { cwd: repoRoot });
  // A silent empty result is the failure mode these checks exist to prevent, so a git that
  // did not answer is a hard error rather than a green sweep over nothing.
  if (!ls.success) throw new Error(`git ls-files failed: ${ls.stderr.toString()}`);
  return ls.stdout.toString().split("\0").filter(Boolean);
}

/** Every tracked `.md` file, read. */
export async function readTrackedMarkdown(): Promise<{ file: string; text: string }[]> {
  return Promise.all(
    trackedMarkdownFiles().map(async (file) => ({ file, text: await Bun.file(repoRoot + file).text() })),
  );
}
