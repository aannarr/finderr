import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { flushCaches, hydrateCaches } from "./lib/api";
import { serviceWorker } from "./lib/sw-register";
import { ToastProvider } from "./lib/toasts";
import { router } from "./router";
import "./styles.css";

/*
  The service worker is installed from the APP bundle only, never from `login.tsx`.

  An anonymous visitor is served a different bundle precisely so they are handed as little
  as possible (see the `fetch` handler in `src/server/index.ts`), and installing a worker on
  their device would be handing them something durable. Signing in is what asks for it.

  Fire and forget: `serviceWorker()` resolves to `null` on every browser that will not have
  one and never rejects, so there is nothing here for the app to wait on or handle.
*/
void serviceWorker();

const el = document.getElementById("root");
if (!el) throw new Error("#root is missing from index.html");

/*
  WHEN TO WRITE THE CACHE BACK -- and `beforeunload` is not among the answers.

  On iOS a backgrounded tab is discarded without ever firing `beforeunload` or `unload`,
  which is precisely the case this whole feature exists for: the reader switches apps, the
  OS reclaims the page, and coming back is a cold start. `visibilitychange -> hidden` and
  `pagehide` are the two the platform actually guarantees, and between them they cover
  switching apps, locking the screen, closing the tab and a plain reload.

  `flushCaches` is a no-op when nothing has changed since the last write, so firing on both
  of two events that often arrive together costs nothing.
*/
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") void flushCaches();
});
window.addEventListener("pagehide", () => void flushCaches());

/*
  RENDERING WAITS FOR THE CACHE, and only this long.

  `SearchRoute` reads the restored front page in a `useState` initialiser, which runs once,
  so a snapshot that lands one tick after the first render is a snapshot nobody ever sees --
  waiting is what makes the feature visible rather than theoretical. `hydrateCaches` carries
  its own deadline and never rejects, so the worst case is that finderr starts exactly as it
  did before any of this existed.

  ToastProvider wraps the router, not the other way round: a toast raised by an action on
  one route must survive navigating away from it.
*/
void hydrateCaches().then(() => {
  createRoot(el).render(
    <StrictMode>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </StrictMode>,
  );
});
