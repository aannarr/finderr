/**
 * What language and region this browser says the reader is in.
 *
 * The one impure line behind `preferredCountries` and `languageNames`, which are both pure
 * and take the list. It lives in its own module rather than beside them because
 * `facet-panes.ts` is deliberately DOM-free -- and it is not private to a component any
 * more: the title page reads it too, to decide which country's streaming offers a service
 * chip is about.
 *
 * A user setting replaces this function and nothing else.
 */
export function browserLocales(): string[] {
  if (typeof navigator === "undefined") return [];
  return [...(navigator.languages ?? [navigator.language])];
}
