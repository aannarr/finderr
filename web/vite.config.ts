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
    port: 7980,
    // In dev the API runs separately; in production Bun serves both from one origin.
    proxy: {
      "/api": "http://localhost:7979",
      "/img": "http://localhost:7979",
    },
  },
});
