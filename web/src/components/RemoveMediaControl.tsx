/**
 * "Take this back out" -- the one destructive control in the product, behind a confirmation
 * that says what it is about to delete.
 *
 * > [!IMPORTANT] IT LIVES ON `/requests` AND `/log` AND NOWHERE ELSE
 * > aannarr's scoping: an operator reviewing what has landed is offered this; a reader
 * > browsing the library never is. Those two pages are the ones somebody is already on in
 * > order to review state, and every other surface -- a title page, a card, a search row --
 * > would put a delete button beside a Request button where it can be misclicked.
 * > `src/lib/removal-surface.test.ts` fails if this component is imported anywhere else,
 * > because "add it to `TitleCard` for convenience" is the obvious next edit.
 *
 * It draws nothing at all for a non-admin and nothing for a request that has not arrived, and
 * both are the SERVER's rules restated rather than re-decided: the endpoint lives under
 * `/api/admin/` and `isRemovable` is the shared predicate it refuses with.
 *
 * The two-click guard, the busy lock and where the failure lands are `ConfirmAction`'s. What
 * is specific to removing media is the QUESTION: it has to state the files, the size, the
 * quality and whether Plex still holds it, and it has to make `deleteFiles` a visible choice
 * -- because unmonitoring and deleting are the same button in most arr clients, and this one
 * must not be.
 */

import { useState } from "react";
import { isRemovable, type MediaRemovalPreview } from "../../../src/lib/media-removal";
import {
  getRemovalPreview,
  type MediaRequest,
  patchTitleState,
  removeMedia,
  requestStatePatch,
} from "../lib/api";
import { count, formatBytes } from "../lib/units";
import { ConfirmAction } from "./ConfirmAction";

export function RemoveMediaControl({
  request,
  isAdmin,
  onRemoved,
}: {
  request: Pick<MediaRequest, "tconst" | "status">;
  /** Display only. The endpoint is what enforces it -- see `AppActions.isAdmin`. */
  isAdmin: boolean;
  /** Reload the list: the row reaches a terminal state and the library mirror loses a title. */
  onRemoved: () => void;
}) {
  /**
   * What the arr says it is holding, fetched when the reader ARMS the control.
   *
   * Three states, and they are genuinely different: `undefined` is "not asked yet", `null` is
   * "asked, and the answer never came back", and a value is the facts. Only the third can
   * name a file count -- see `RemovalFacts`.
   */
  const [preview, setPreview] = useState<MediaRemovalPreview | null | undefined>(undefined);
  /**
   * Do the FILES go too, or only the arr's entry?
   *
   * DEFAULTS TO FALSE, which is the safe half of the choice: the arr forgets the title either
   * way, and a disk is only touched once somebody has said so. It also keeps the standing
   * replacement-first rule reachable -- take the entry out now, delete the file once the
   * better copy has been verified.
   */
  const [deleteFiles, setDeleteFiles] = useState(false);

  if (!isAdmin || !isRemovable(request.status)) return null;

  return (
    <div>
      <ConfirmAction
        label="Remove"
        danger
        // The facts are gathered on ARM and never on render: the lookup costs the arr a call,
        // and a page of arrived requests would otherwise fire one per row for a button
        // nobody pressed.
        onAsk={() => {
          setPreview(undefined);
          getRemovalPreview(request.tconst)
            .then(setPreview)
            .catch(() => setPreview(null));
        }}
        question={<RemovalFacts preview={preview} deleteFiles={deleteFiles} onToggleFiles={setDeleteFiles} />}
        // The verb SAYS WHICH ACT IT IS, because the checkbox above it changes what pressing
        // this does. "Yes, remove it" under a ticked delete box would be the confirmation
        // describing the safer of the two things it is about to do.
        confirmLabel={deleteFiles ? "Yes, delete the files" : "Yes, remove it"}
        busyLabel="Removing…"
        cancelLabel="Keep it"
        onConfirm={async () => {
          await removeMedia(request.tconst, { deleteFiles });
          // Every cached view of this title still says it is in the library and still carries
          // the request badge, so both are corrected through the shared caches rather than by
          // reloading each view -- the same call `WithdrawControl` makes for the same reason.
          patchTitleState(request.tconst, {
            ...requestStatePatch("removed"),
            inLibrary: false,
            hasFile: false,
          });
          onRemoved();
        }}
      />
    </div>
  );
}

/**
 * What is about to go, and the one choice about how far it goes.
 *
 * WHILE THE FACTS ARE STILL LOADING it says so rather than showing a bare "are you sure" --
 * an admin who pressed Remove and saw nothing would be answering a question nobody asked. The
 * Yes button stays enabled either way, which is deliberate: the arr lookup is a courtesy, and
 * a failed one must not lock an operator out of removing something they have already decided
 * about. Its own component so the wording can be asserted without driving the guard.
 */
export function RemovalFacts({
  preview,
  deleteFiles,
  onToggleFiles,
}: {
  preview: MediaRemovalPreview | null | undefined;
  deleteFiles: boolean;
  onToggleFiles: (next: boolean) => void;
}) {
  return (
    <span className="flex flex-col gap-1">
      <span>
        {preview === undefined
          ? "Checking what is on disk…"
          : preview === null
            ? "Could not read what is on disk. Removing will still take it out of the arr."
            : holdingsLine(preview)}
      </span>
      {preview?.inPlex && (
        // Said only when it is TRUE, because "Plex does not have this" is not a warning and a
        // line that is always there stops being read. When it IS true it is the fact that
        // decides the checkbox: leaving the files means the household keeps watching it.
        <span>Plex still holds this.</span>
      )}
      <label className="flex items-baseline gap-2">
        <input
          type="checkbox"
          checked={deleteFiles}
          onChange={(e) => onToggleFiles(e.target.checked)}
          className="translate-y-0.5"
        />
        {/*
          The wording carries the CONSEQUENCE rather than the field name. `deleteFiles` is what
          the arr calls it; what an operator needs to read is which half is irreversible, and
          that leaving it off still takes the title out of the arr.
        */}
        <span>Delete the files from disk as well. Without this, only the arr entry goes.</span>
      </label>
    </span>
  );
}

/** `Remove "Inception"? 1 file, 12.4 GB, Bluray-1080p.` -- whichever parts the arr answered. */
function holdingsLine(preview: MediaRemovalPreview): string {
  const parts = [count(preview.files, "file")];
  if (preview.bytes !== null) parts.push(formatBytes(preview.bytes));
  if (preview.quality !== null) parts.push(preview.quality);
  return `Remove “${preview.title}”? ${parts.join(", ")}.`;
}
