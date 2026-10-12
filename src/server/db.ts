import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_pending (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ingredients (
  id TEXT PRIMARY KEY,
  owner_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  brand TEXT,
  category TEXT NOT NULL,
  state TEXT,
  kcal_100g REAL NOT NULL,
  protein_100g REAL NOT NULL,
  carbs_100g REAL NOT NULL,
  fat_100g REAL NOT NULL,
  grams_per_unit REAL,
  unit_name TEXT,
  source TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ingredients_owner ON ingredients(owner_id);

CREATE TABLE IF NOT EXISTS recipes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  photo_url TEXT,
  base_servings REAL NOT NULL,
  main_item_id TEXT,
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipes_owner ON recipes(owner_id);

CREATE TABLE IF NOT EXISTS recipe_items (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id TEXT NOT NULL REFERENCES ingredients(id),
  grams REAL NOT NULL,
  display_unit TEXT NOT NULL CHECK (display_unit IN ('g', 'unit')),
  scalable INTEGER NOT NULL,
  position INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_items_recipe ON recipe_items(recipe_id);

CREATE TABLE IF NOT EXISTS recipe_steps (
  id TEXT PRIMARY KEY,
  recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recipe_steps_recipe ON recipe_steps(recipe_id);
`;

interface SeedIngredient {
  id: string;
  name: string;
  category: string;
  state: string | null;
  kcal100g: number;
  protein100g: number;
  carbs100g: number;
  fat100g: number;
  gramsPerUnit: number | null;
  unitName: string | null;
  source: unknown;
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(dirname(resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  seedIngredients(db);
  return db;
}

/** Upserts the curated USDA ingredient base (global rows have owner_id NULL). */
function seedIngredients(db: DatabaseSync): void {
  const rows: SeedIngredient[] = JSON.parse(readFileSync(resolve(ROOT, "data/ingredients.json"), "utf8"));
  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO ingredients (id, owner_id, name, brand, category, state, kcal_100g, protein_100g, carbs_100g, fat_100g, grams_per_unit, unit_name, source, created_at)
    VALUES (?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, category = excluded.category, state = excluded.state,
      kcal_100g = excluded.kcal_100g, protein_100g = excluded.protein_100g, carbs_100g = excluded.carbs_100g,
      fat_100g = excluded.fat_100g, grams_per_unit = excluded.grams_per_unit, unit_name = excluded.unit_name,
      source = excluded.source
    WHERE ingredients.owner_id IS NULL`);
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      upsert.run(r.id, r.name, r.category, r.state, r.kcal100g, r.protein100g, r.carbs100g, r.fat100g,
        r.gramsPerUnit, r.unitName, JSON.stringify(r.source), now);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
