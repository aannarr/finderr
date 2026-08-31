/**
 * What `collection:"lord of the rings"` in the search box does.
 *
 * A franchise name is an ADDRESS, so the token resolves to a node and goes there rather
 * than producing a page of results -- which is the whole reason collections became a
 * route. Search itself could not answer this anyway: membership lives in the facet cache
 * and the search index is a different database.
 *
 * **Ambiguity is shown, never guessed.** Collection names are neither unique nor stable,
 * and a token that sometimes lands on the wrong franchise is worse than no token -- so
 * one match navigates and several ask.
 *
 * AND AN UNFINISHED NAME IS AMBIGUOUS, however few things it matches. Every keystroke
 * reaches the URL, so `collection:star trek` is read as `collection:star` on the way in --
 * which matches exactly one collection, Star Wars, and used to navigate there with
 * `replace`, discarding the rest of what was being typed with no way Back. Uniqueness at
 * one instant is not the same fact as the reader having finished, and no amount of
 * debouncing tells the two apart: a pause is not a decision. So auto-navigation waits for
 * the CLOSED QUOTE (`token.closed`), which is the reader saying so. An unquoted token
 * still resolves and still renders its matches -- a single one as a single link, one
 * click from the same destination.
 */

import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { type CollectionSummary, findCollections } from "../lib/api";

type Resolution =
  | { state: "resolving" }
  | { state: "matched"; matches: CollectionSummary[] }
  | { state: "failed"; message: string };

export function CollectionJump({ name, closed }: { name: string; closed: boolean }) {
  const navigate = useNavigate();
  const [resolution, setResolution] = useState<Resolution>({ state: "resolving" });

  useEffect(() => {
    let stale = false;
    setResolution({ state: "resolving" });
    findCollections(name)
      .then((matches) => {
        if (!stale) setResolution({ state: "matched", matches });
      })
      .catch((e: Error) => {
        if (!stale) setResolution({ state: "failed", message: e.message });
      });
    return () => {
      stale = true;
    };
  }, [name]);

  const only =
    resolution.state === "matched" && resolution.matches.length === 1 ? resolution.matches[0] : null;
  /** One match AND a finished name. Either alone is not an address. */
  const jumpTo = closed ? only : null;

  useEffect(() => {
    // REPLACE, not push: the token was a way of typing an address, so Back should return
    // to wherever the reader came from rather than to the half-typed query.
    if (jumpTo) navigate({ to: "/collection/$id", params: { id: jumpTo.id }, replace: true });
  }, [jumpTo, navigate]);

  if (resolution.state === "resolving" || jumpTo) return null;

  if (resolution.state === "failed") {
    return <p className="py-16 text-center text-muted">{resolution.message}</p>;
  }

  if (resolution.matches.length === 0) {
    return (
      <p className="py-16 text-center text-muted">
        No collection called “{name}” yet.
        <br />
        {/*
          Not a dead end and not a bug: a collection becomes addressable once any of its
          films has been viewed, because that is when its membership is cached. Saying so
          beats "nothing matches", which would read as "this franchise does not exist".
        */}
        <span className="text-xs">A collection appears here once one of its films has been opened.</span>
      </p>
    );
  }

  return (
    <div className="py-8">
      {/*
        One match reads as an offer, several as a question. The single-match wording
        matters more than it looks: this is the branch an unquoted token lands in, so it
        is what a reader sees mid-typing, and "Which collection?" over one row would read
        as though the answer were in doubt when it is not.
      */}
      <p className="mb-3 text-sm text-muted">
        {resolution.matches.length === 1 ? "Go to" : "Which collection?"}
      </p>
      <ul className="space-y-1">
        {resolution.matches.map((c) => (
          <li key={c.id}>
            <Link
              to="/collection/$id"
              params={{ id: c.id }}
              className="text-sm text-muted underline decoration-line underline-offset-2 hover:text-ink"
            >
              {c.name}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
