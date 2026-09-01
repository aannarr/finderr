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
