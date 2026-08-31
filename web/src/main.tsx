import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastProvider } from "./lib/toasts";
import { router } from "./router";
import "./styles.css";

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
