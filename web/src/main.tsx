import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
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

// ToastProvider wraps the router, not the other way round: a toast raised by an
// action on one route must survive navigating away from it.
createRoot(el).render(
  <StrictMode>
    <ToastProvider>
      <RouterProvider router={router} />
    </ToastProvider>
  </StrictMode>,
);
