import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the notebook panel into one self-contained HTML file (dist/panel/index.html)
// that the MCP server serves as its ui:// resource.
export default defineConfig({
  root: "src/panel",
  plugins: [viteSingleFile()],
  build: { outDir: "../../dist/panel", emptyOutDir: true },
});
