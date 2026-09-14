/**
 * The share button: absent without a sheet, and handing the sheet the address the preview answers.
 *
 * Behaviour tests, because every failure worth catching here is invisible at rest -- a button
 * that draws and then sends the wrong URL, or throws a red toast at a reader who merely closed
 * the sheet, renders identical markup to a correct one.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { canShareLinks, shareTitle, shareUrl } from "../lib/share";
import { ToastProvider } from "../lib/toasts";
import { fireEvent, render, screen, waitFor } from "../test/interact";
import { ShareButton } from "./ShareButton";

type ShareFn = (data: ShareData) => Promise<void>;

function giveNavigatorShare(share: ShareFn | undefined) {
  Object.defineProperty(navigator, "share", { value: share, configurable: true, writable: true });
  Object.defineProperty(navigator, "canShare", { value: undefined, configurable: true, writable: true });
}

afterEach(() => giveNavigatorShare(undefined));

function mount() {
  return render(
    <ToastProvider>
      <ShareButton name="Heat" shareAs="Heat (1995)" path="/title/tt0113277" />
    </ToastProvider>,
  );
}

describe("whether there is a sheet to open", () => {
  test("no navigator.share means no button at all", () => {
    giveNavigatorShare(undefined);
    mount();
    expect(screen.queryByRole("button", { name: "Share Heat" })).toBeNull();
  });

  test("a browser that refuses a link payload is treated as having no sheet", () => {
    const nav = { share: async () => {}, canShare: () => false } as unknown as Navigator;
    expect(canShareLinks(nav)).toBe(false);
    expect(canShareLinks(undefined)).toBe(false);
  });
});

describe("pressing it", () => {
  test("opens the sheet with the title and the preview-shaped address", async () => {
    const share = mock<ShareFn>(async () => {});
    giveNavigatorShare(share);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Share Heat" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    expect(share.mock.calls[0]?.[0]).toEqual({
      title: "Heat (1995)",
      url: `${location.origin}/title/tt0113277`,
    });
  });

  test("closing the sheet is not an error and draws no toast", async () => {
    const share = mock<ShareFn>(async () => {
      throw new DOMException("dismissed", "AbortError");
    });
    giveNavigatorShare(share);
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Share Heat" }));

    await waitFor(() => expect(share).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Share Heat" })).not.toHaveProperty("disabled", true),
    );
    expect(screen.queryByText("Sharing Heat")).toBeNull();
  });
});

describe("the address", () => {
  test("carries no trailing slash, because the preview path is anchored without one", () => {
    expect(shareUrl("/person/nm0000138", "https://finderr.example.com")).toBe(
      "https://finderr.example.com/person/nm0000138",
    );
  });

  test("the sheet title carries the year only when there is one", () => {
    expect(shareTitle("Heat", 1995)).toBe("Heat (1995)");
    expect(shareTitle("Heat", null)).toBe("Heat");
  });
});
