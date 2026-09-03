/**
 * The SPARQL client, against a fake `fetch` and never the real endpoint.
 *
 * A test that queried Wikidata for real would be a test that fails when somebody else's
 * public service is busy -- which, measured, it regularly is. What is worth pinning here is
 * the contract this module actually owns: the request it builds, and the unwrapping of an
 * envelope whose shape is three levels deep for no reason a caller should have to know.
 */

import { describe, expect, test } from "bun:test";
import { sparqlSelect, WIKIDATA_ENDPOINT, WIKIDATA_USER_AGENT } from "./wikidata";

/** A `fetch` that answers with one canned body and records what it was asked. */
function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; headers: Headers }[] = [];
  const impl = (async (url: string | URL, opts?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(opts?.headers) });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      statusText: "",
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("sparqlSelect", () => {
  test("unwraps the binding envelope to plain columns", () => {
    const { impl } = fakeFetch({
      results: {
        bindings: [
          {
            year: { type: "literal", value: "1994" },
            imdb: { type: "literal", value: "tt0110912" },
            label: { "xml:lang": "en", type: "literal", value: "Pulp Fiction" },
          },
        ],
      },
    });
    return sparqlSelect("SELECT ?x WHERE {}", { fetchImpl: impl }).then((rows) => {
      expect(rows).toEqual([{ year: "1994", imdb: "tt0110912", label: "Pulp Fiction" }]);
    });
  });

  test("an unbound column is undefined rather than an empty string", async () => {
    // "the query returned no value for this row" and "the value is empty" are different
    // facts, and the importer skips on the first one.
    const { impl } = fakeFetch({ results: { bindings: [{ year: {}, imdb: { value: "tt1" } }] } });
    const rows = await sparqlSelect("SELECT ?x WHERE {}", { fetchImpl: impl });
    expect(rows[0]?.year).toBeUndefined();
    expect(rows[0]?.imdb).toBe("tt1");
  });

  test("an empty answer is an empty list, not a throw", async () => {
    const { impl } = fakeFetch({ head: { vars: [] }, results: { bindings: [] } });
    expect(await sparqlSelect("SELECT ?x WHERE {}", { fetchImpl: impl })).toEqual([]);
  });

  test("sends the query in the URL, asks for JSON, and says who is asking", async () => {
    // Wikimedia's user-agent policy refuses a generic one outright, and the endpoint answers
    // with its HTML query editor to a caller that does not ask for the results format.
    const { impl, calls } = fakeFetch({ results: { bindings: [] } });
    await sparqlSelect("SELECT ?a WHERE { ?a ?b ?c }", { fetchImpl: impl });
    expect(calls[0]?.url.startsWith(`${WIKIDATA_ENDPOINT}?query=`)).toBe(true);
    expect(decodeURIComponent(calls[0]?.url.split("?query=")[1] ?? "")).toBe("SELECT ?a WHERE { ?a ?b ?c }");
    expect(calls[0]?.headers.get("Accept")).toBe("application/sparql-results+json");
    expect(calls[0]?.headers.get("User-Agent")).toBe(WIKIDATA_USER_AGENT);
  });

  test("a 502 throws, so the import leaves the stored rows alone", async () => {
    // The endpoint's ordinary bad day: one call in eight returned 502 when this was measured.
    // Throwing is what makes the job's swap never happen.
    const { impl } = fakeFetch({}, { ok: false, status: 502 });
    expect(sparqlSelect("SELECT ?x WHERE {}", { fetchImpl: impl })).rejects.toThrow(/502/);
  });
});
