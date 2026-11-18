import { defineConfig, type Plugin } from "vite";
import { existsSync, mkdirSync, readdirSync, copyFileSync, createReadStream } from "node:fs";
import { resolve, join, extname } from "node:path";

// ───────────────────────────────────────────────────────────────────────────────
// THE one and only place the sound folder is declared: Liv's own WAVs, inside
// the repository, made by `npm run sounds` (scripts/gen-sounds.mjs). Without
// the folder Liv still builds and runs, silent.
export const SOUNDS_DIR = resolve(__dirname, "resources/sounds");
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Serves SOUNDS_DIR at /sounds/*.wav in dev, and copies it into dist/sounds on build,
 * so the WAVs ship inside the installer. A missing folder is not an error: no sounds.
 */
function sounds(): Plugin {
  const prefix = "/sounds/";
  return {
    name: "liv-sounds",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith(prefix)) return next();
        const name = decodeURIComponent(req.url.slice(prefix.length).split("?")[0]);
        if (name.includes("/") || name.includes("\\") || extname(name) !== ".wav") return next();
        const file = join(SOUNDS_DIR, name);
        if (!existsSync(file)) return next();
        res.setHeader("Content-Type", "audio/wav");
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      if (!existsSync(SOUNDS_DIR)) return;
      const out = resolve(__dirname, "dist/sounds");
      mkdirSync(out, { recursive: true });
      for (const f of readdirSync(SOUNDS_DIR)) {
        if (extname(f) === ".wav") copyFileSync(join(SOUNDS_DIR, f), join(out, f));
      }
    },
  };
}

export default defineConfig({
  plugins: [sounds()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    // Cargo writes and locks files under target/ while Vite starts; watching them
    // crashes Vite on Windows with EBUSY. Tauri watches src-tauri/ itself.
    // The reference projects beside the source (see .gitignore) are not Liv's:
    // watching their thousands of files would only slow the dev server down.
    watch: {
      ignored: ["**/target/**", "**/src-tauri/**", "**/coucou-main/**", "**/island-main/**", "**/NusaSetup/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "chrome110",
    minify: "esbuild",
    sourcemap: false,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        island: resolve(__dirname, "index.html"),
        settings: resolve(__dirname, "settings.html"),
        pet: resolve(__dirname, "pet.html"),
      },
      output: {
        // The interface's strings (src/i18n/*.json) make a chunk of their own,
        // kept apart from the code that changes more often.
        manualChunks: (id) => (/[\\/]src[\\/]i18n[\\/][^\\/]+\.json$/.test(id) ? "i18n" : undefined),
      },
    },
  },
});
