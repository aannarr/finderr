import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    /**
     * TWO entries, and the second one is a security boundary rather than a page.
     *
     * `login.html` is what an anonymous visitor is served (see the `fetch` handler in
     * `src/server/index.ts`). Keeping it out of the app's entry means the application
     * bundle -- which names every route and API shape finderr has -- is never handed to
     * somebody who has not signed in. They share `styles.css` and the auth client, and
     * nothing else.
     */
    rollupOptions: {
      input: {
        main: `${import.meta.dirname}/index.html`,
        login: `${import.meta.dirname}/login.html`,
        /**
         * The service worker, as a third entry rather than a hand-written file in
         * `public/`.
         *
         * It buys the same thing every other module in this tree gets: TypeScript, and a
         * policy split into `web/src/lib/sw-policy.ts` that has real tests. A worker pasted
         * into `public/` would be plain JS nothing typechecks and nothing can import.
         */
        sw: `${import.meta.dirname}/src/sw.ts`,
      },
      output: {
        /**
         * THE WORKER'S FILENAME IS NOT HASHED, AND THAT IS NOT AN OVERSIGHT.
         *
         * A service worker's URL is its identity: the browser fetches the same address and
         * compares bytes to decide whether an update exists. Hash the name and every
         * release registers a NEW worker while the old one stays alive at its old address,
         * controlling the same pages forever. It also has to sit at the root to claim the
         * root scope -- a worker at `/assets/sw.js` may only control `/assets/`.
         *
         * `web/src/lib/sw-register.ts` names the same path. The two must agree.
         */
        entryFileNames: (chunk) => (chunk.name === "sw" ? "sw.js" : "assets/[name]-[hash].js"),
      },
    },
  },
  server: {
    /**
     * Both are overridable, because the defaults assume this checkout is the only finderr
     * on the machine and that is routinely false.
     *
     * `FINDERR_DEV_API` matters more than the port does: the proxy target was hardcoded to
     * `localhost:7979`, which is the port a RUNNING CONTAINER holds on any machine where one
     * is up. A second dev server then silently served its own UI against the container's
     * API -- every request answered, nothing broken on screen, and none of it exercising the
     * code being edited. Pointing it is a flag now rather than an edit.
     */
    port: Number(process.env.FINDERR_DEV_WEB_PORT ?? 7980),
    // `true` binds every interface. A dev server is often read from a second machine --
    // a phone, or a laptop that is not the one running it -- and localhost cannot be.
    host: true,
    // In dev the API runs separately; in production Bun serves both from one origin.
    proxy: (() => {
      const api = process.env.FINDERR_DEV_API ?? "http://localhost:7979";
      return { "/api": api, "/img": api, "/logos": api };
    })(),
  },
});
