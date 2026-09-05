/**
 * The pre-auth bundle's entry point.
 *
 * Separate from `main.tsx` so an anonymous visitor is never handed the application's
 * chunk. It shares only `styles.css` and `lib/auth-api.ts` -- no router, no API client,
 * no components that know what this product does.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthScreen } from "./auth/AuthScreen";
import { watchFieldScale } from "./lib/field-zoom";
import "./styles.css";

/* See `main.tsx` for why this runs before the render. The invite field is a text input and
   zooms on focus exactly like the search box does. */
watchFieldScale(window);

const el = document.getElementById("root");
if (!el) throw new Error("#root is missing from login.html");

createRoot(el).render(
  <StrictMode>
    <AuthScreen />
  </StrictMode>,
);
