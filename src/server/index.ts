import { openDatabase } from "./db.js";
import { createApp } from "./app.js";

loadEnvFile();

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, "");
const DATABASE_PATH = process.env.DATABASE_PATH ?? "./data/recipe-notebook.db";
const PHOTO_DOMAINS = (process.env.PHOTO_DOMAINS ?? "https://images.unsplash.com,https://i.imgur.com,https://upload.wikimedia.org")
  .split(",").map((d) => d.trim()).filter(Boolean);

const db = openDatabase(DATABASE_PATH);
const { app, close } = createApp({ db, publicUrl: PUBLIC_URL, photoDomains: PHOTO_DOMAINS });

const http = app.listen(PORT, HOST, () => {
  console.error(`[recipe-notebook] MCP endpoint: ${PUBLIC_URL}/mcp`);
  console.error(`[recipe-notebook] listening on http://${HOST}:${PORT} (db: ${DATABASE_PATH})`);
});

async function shutdown() {
  await close();
  http.close(() => {
    db.close();
    process.exit(0);
  });
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

function loadEnvFile() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // .env is optional
  }
}
