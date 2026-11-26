import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The renderer is loaded from file:// in production, so asset URLs must be relative.
export default defineConfig({
  base: "./",
  plugins: [react()],
  server: { port: 5199, strictPort: true },
  build: { outDir: "dist", emptyOutDir: true },
});
