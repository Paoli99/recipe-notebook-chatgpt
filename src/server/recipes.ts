import type { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  LIMITS,
  RECIPE_CATEGORIES,
  RecipeInputError,
  assertPositiveNumber,
  computePreview,
  macrosFor,
  stepReferences,
  subtractMacros,
  type Adjustment,
  type IngredientInfo,
  type Macros,
  type Recipe,
  type RecipeCategory,
  type RecipePreview,
} from "../shared/recipe-math.js";
import { transaction } from "./db.js";

export const INGREDIENT_CATEGORIES = [
  "poultry", "meat", "seafood", "egg", "plant-protein", "legume", "dairy", "cheese", "grain",
  "pasta", "bread", "starchy-vegetable", "vegetable", "fruit", "nut-seed", "fat-oil",
  "sweetener", "baking", "condiment", "spice", "herb", "drink", "other",
] as const;

/** Categories that can stand in for each other when suggesting substitutes. */
const RELATED_CATEGORIES: Record<string, string[]> = {
  poultry: ["meat", "seafood", "plant-protein"],
  meat: ["poultry", "seafood", "plant-protein"],
  seafood: ["poultry", "meat", "plant-protein"],
  "plant-protein": ["legume", "poultry"],
  legume: ["plant-protein"],
  dairy: ["cheese"],
  cheese: ["dairy"],
  grain: ["pasta", "starchy-vegetable"],
  pasta: ["grain"],
  "starchy-vegetable": ["grain"],
  "fat-oil": ["dairy"],
  sweetener: [],
  drink: ["dairy"],
  "nut-seed": [],
};

export class NotFoundError extends RecipeInputError {
  constructor(what: string) {
    super("not_found", `${what} was not found.`);
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

interface IngredientRow {
  id: string;
  owner_id: string | null;
  name: string;
  brand: string | null;
  category: string;
  state: string | null;
  kcal_100g: number;
  protein_100g: number;
  carbs_100g: number;
  fat_100g: number;
  grams_per_unit: number | null;
  unit_name: string | null;
}

function toIngredient(r: IngredientRow): IngredientInfo {
  return {
    id: r.id,
    name: r.name,
    brand: r.brand,
    category: r.category,
    state: r.state,
    kcal100g: r.kcal_100g,
    protein100g: r.protein_100g,
    carbs100g: r.carbs_100g,
    fat100g: r.fat_100g,
    gramsPerUnit: r.grams_per_unit,
    unitName: r.unit_name,
    custom: r.owner_id !== null,
  };
}

export interface NewRecipeItemInput {
  key: string;
  ingredientId: string;
  grams?: number;
  units?: number;
  scalable?: boolean;
}

export interface NewRecipeInput {
  title: string;
  category?: RecipeCategory;
  photoUrl?: string | null;
  servings: number;
  notes?: string | null;
  mainItemKey?: string | null;
  items: NewRecipeItemInput[];
  steps: string[];
}

export interface NewIngredientInput {
  name: string;
  brand?: string | null;
  category: string;
  state?: string | null;
  kcal100g: number;
  protein100g: number;
  carbs100g: number;
  fat100g: number;
  gramsPerUnit?: number | null;
  unitName?: string | null;
}

export interface SubstituteSuggestion {
  ingredient: IngredientInfo;
  grams: number;
  macros: Macros;
  diff: Macros;
}

export interface SaveOptions {
  mode: "overwrite" | "copy";
  adjustment?: Adjustment;
  title?: string;
  photoUrl?: string | null;
  notes?: string | null;
  category?: RecipeCategory;
  /** Replacement step texts. Reference items as {item:<itemId>} using the recipe's current item IDs. */
  steps?: string[];
}

export interface RecipeSummary {
  id: string;
  title: string;
  category: RecipeCategory;
  photoUrl: string | null;
  servings: number;
  kcalPerServing: number;
  mainIngredient: string | null;
  mainGrams: number | null;
  isDemo: boolean;
  updatedAt: string;
}

/**
 * All recipe and ingredient access for one authenticated user. The user ID
 * always comes from the verified access token, never from tool arguments.
 */
export class RecipeService {
  constructor(private readonly db: DatabaseSync, private readonly userId: string) {}

  // ---------- Ingredients ----------

  getIngredient(id: string): IngredientInfo | undefined {
    const row = this.db
      .prepare("SELECT * FROM ingredients WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)")
      .get(id, this.userId) as IngredientRow | undefined;
    return row ? toIngredient(row) : undefined;
  }

  searchIngredients(query: string, category?: string, limit = 20): IngredientInfo[] {
    const words = searchWords(query);
    const q = words[0] ?? "";
    if (category && !(INGREDIENT_CATEGORIES as readonly string[]).includes(category)) {
      throw new RecipeInputError("invalid_category", `Unknown ingredient category "${category}". Use one of: ${INGREDIENT_CATEGORIES.join(", ")}.`);
    }
    const max = Math.min(Math.max(Math.trunc(limit) || 20, 1), 50);
    const rows = this.db
      .prepare(`SELECT * FROM ingredients WHERE (owner_id IS NULL OR owner_id = ?)
        AND (? = '' OR lower(name) LIKE ? OR lower(coalesce(brand, '')) LIKE ? OR id LIKE ?)
        AND (? IS NULL OR category = ?)
        ORDER BY (owner_id IS NULL), CASE WHEN lower(name) LIKE ? THEN 0 ELSE 1 END, name LIMIT ?`)
      .all(this.userId, q, `%${q}%`, `%${q}%`, `%${q}%`, category ?? null, category ?? null, `${q}%`, 500) as unknown as IngredientRow[];
    return rows
      .filter((r) => words.every((w) => `${r.name} ${r.brand ?? ""} ${r.id}`.toLowerCase().includes(w)))
      .slice(0, max)
      .map(toIngredient);
  }

  createIngredient(input: NewIngredientInput): IngredientInfo {
    const name = requireText(input.name, "name", 120);
    const brand = optionalText(input.brand, "brand", 80);
    if (!(INGREDIENT_CATEGORIES as readonly string[]).includes(input.category)) {
      throw new RecipeInputError("invalid_category", `category must be one of: ${INGREDIENT_CATEGORIES.join(", ")}.`);
    }
    const kcal = nonNegative(input.kcal100g, "kcal100g", 900);
    const protein = nonNegative(input.protein100g, "protein100g", 100);
    const carbs = nonNegative(input.carbs100g, "carbs100g", 100);
    const fat = nonNegative(input.fat100g, "fat100g", 100);
    if (protein + carbs + fat > 100.5) {
      throw new RecipeInputError("invalid_nutrition", "protein + carbs + fat cannot exceed 100 g per 100 g.");
    }
    let gramsPerUnit: number | null = null;
    let unitName: string | null = null;
    if (input.gramsPerUnit !== undefined && input.gramsPerUnit !== null) {
      gramsPerUnit = assertPositiveNumber(input.gramsPerUnit, "gramsPerUnit", 5000);
      unitName = requireText(input.unitName ?? "", "unitName (required with gramsPerUnit)", 40);
    }
    const id = newId("ing");
    this.db
      .prepare(`INSERT INTO ingredients (id, owner_id, name, brand, category, state, kcal_100g, protein_100g, carbs_100g, fat_100g, grams_per_unit, unit_name, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, this.userId, name, brand, input.category, optionalText(input.state, "state", 30), kcal, protein, carbs, fat,
        gramsPerUnit, unitName, JSON.stringify({ dataset: "user" }), new Date().toISOString());
    return this.getIngredient(id)!;
  }

  // ---------- Recipes ----------

  listRecipes(query = ""): RecipeSummary[] {
    const words = searchWords(query);
    const ids = (this.db
      .prepare(`SELECT id, title FROM recipes WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 500`)
      .all(this.userId) as { id: string; title: string }[])
      .filter((r) => words.every((w) => r.title.toLowerCase().includes(w)))
      .slice(0, 100);
    return ids.map(({ id }) => {
      const recipe = this.getRecipe(id);
      const p = computePreview(recipe);
      return {
        id,
        title: p.title,
        category: p.category,
        photoUrl: p.photoUrl,
        servings: p.servings,
        kcalPerServing: p.perServing.kcal,
        mainIngredient: p.items.find((i) => i.isMain)?.ingredient.name ?? null,
        mainGrams: p.mainGrams,
        isDemo: p.isDemo,
        updatedAt: recipe.updatedAt,
      };
    });
  }

  getRecipe(id: string): Recipe {
    const r = this.db
      .prepare("SELECT * FROM recipes WHERE id = ? AND owner_id = ?")
      .get(id, this.userId) as Record<string, unknown> | undefined;
    // Same error for "missing" and "someone else's" so IDs cannot be probed.
    if (!r) throw new NotFoundError(`Recipe "${id}"`);
    const items = this.db
      .prepare(`SELECT ri.id AS item_id, ri.grams, ri.display_unit, ri.scalable, ri.position, i.*
        FROM recipe_items ri JOIN ingredients i ON i.id = ri.ingredient_id
        WHERE ri.recipe_id = ? ORDER BY ri.position`)
      .all(id) as unknown as (IngredientRow & { item_id: string; grams: number; display_unit: "g" | "unit"; scalable: number; position: number })[];
    const steps = this.db
      .prepare("SELECT id, position, text FROM recipe_steps WHERE recipe_id = ? ORDER BY position")
      .all(id) as unknown as { id: string; position: number; text: string }[];
    return {
      id: r.id as string,
      title: r.title as string,
      category: r.category as RecipeCategory,
      photoUrl: (r.photo_url as string | null) ?? null,
      baseServings: r.base_servings as number,
      mainItemId: (r.main_item_id as string | null) ?? null,
      notes: (r.notes as string | null) ?? null,
      isDemo: r.is_demo === 1,
      updatedAt: r.updated_at as string,
      items: items.map((row) => ({
        id: row.item_id,
        ingredient: toIngredient(row),
        grams: row.grams,
        displayUnit: row.display_unit,
        scalable: row.scalable === 1,
        position: row.position,
      })),
      steps: steps.map((s) => ({ id: s.id, position: s.position, text: s.text })),
    };
  }

  preview(id: string, adjustment: Adjustment = {}): RecipePreview {
    const recipe = this.getRecipe(id);
    return computePreview(recipe, adjustment, (ingId) => this.getIngredient(ingId));
  }

  suggestSubstitutes(id: string, itemId: string, adjustment: Adjustment = {}, limit = 8): {
    preview: RecipePreview;
    item: RecipePreview["items"][number];
    suggestions: SubstituteSuggestion[];
  } {
    // The item's quantity in the current preview, minus any substitution of this same item.
    const others = { ...adjustment, substitutions: (adjustment.substitutions ?? []).filter((s) => s.itemId !== itemId) };
    const preview = this.preview(id, others);
    const item = preview.items.find((i) => i.id === itemId);
    if (!item) throw new RecipeInputError("unknown_item", `Item "${itemId}" is not part of this recipe.`);
    const current = item.ingredient;
    const categories = [current.category, ...(RELATED_CATEGORIES[current.category] ?? [])];
    const placeholders = categories.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM ingredients WHERE (owner_id IS NULL OR owner_id = ?) AND id != ? AND category IN (${placeholders})`)
      .all(this.userId, current.id, ...categories) as unknown as IngredientRow[];
    const base = macrosFor(current, item.grams);
    const suggestions = rows
      .map(toIngredient)
      .map((ingredient) => {
        const macros = macrosFor(ingredient, item.grams);
        return { ingredient, grams: item.grams, macros, diff: subtractMacros(macros, base) };
      })
      .sort((a, b) => {
        const rank = (s: SubstituteSuggestion) =>
          (s.ingredient.category === current.category ? 0 : 1000) +
          (s.ingredient.state === current.state ? 0 : 200) +
          Math.abs(s.diff.kcal) + Math.abs(s.diff.protein) * 4;
        return rank(a) - rank(b);
      })
      .slice(0, Math.min(Math.max(limit, 1), 12));
    return { preview, item, suggestions };
  }

  createRecipe(input: NewRecipeInput): Recipe {
    const title = requireText(input.title, "title", 140);
    const category = checkCategory(input.category ?? "other");
    const photoUrl = checkPhotoUrl(input.photoUrl);
    const notes = optionalText(input.notes, "notes", 2000);
    const servings = assertPositiveNumber(input.servings, "servings", LIMITS.maxServings);
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new RecipeInputError("invalid_recipe", "A recipe needs at least one ingredient.");
    }
    if (input.items.length > 80) throw new RecipeInputError("invalid_recipe", "A recipe can have at most 80 ingredients.");
    if (!Array.isArray(input.steps) || input.steps.length > 60) {
      throw new RecipeInputError("invalid_recipe", "steps must be a list of at most 60 strings.");
    }

    const keyToId = new Map<string, string>();
    const items = input.items.map((it, position) => {
      const key = requireText(it.key, `items[${position}].key`, 60);
      if (keyToId.has(key)) throw new RecipeInputError("invalid_recipe", `Item key "${key}" is used twice.`);
      const ingredient = this.getIngredient(it.ingredientId);
      if (!ingredient) {
        throw new RecipeInputError("unknown_ingredient", `Ingredient "${it.ingredientId}" was not found. Use search_ingredients or create_ingredient first.`);
      }
      const scalable = it.scalable ?? true;
      let grams: number;
      let displayUnit: "g" | "unit" = "g";
      if (it.units !== undefined && it.grams !== undefined) {
        throw new RecipeInputError("ambiguous_quantity", `${ingredient.name}: give either grams or units, not both.`);
      }
      if (it.units !== undefined) {
        if (!ingredient.gramsPerUnit) {
          throw new RecipeInputError("no_unit_weight", `${ingredient.name} has no unit weight; give grams instead.`);
        }
        grams = assertPositiveNumber(it.units, `${ingredient.name} units`, 1000) * ingredient.gramsPerUnit;
        displayUnit = "unit";
      } else if (it.grams === 0 && !scalable) {
        grams = 0; // "to taste"
      } else {
        grams = assertPositiveNumber(it.grams, `${ingredient.name} grams`, LIMITS.maxGrams);
      }
      const id = newId("itm");
      keyToId.set(key, id);
      return { id, ingredientId: ingredient.id, grams, displayUnit, scalable, position };
    });

    const steps = input.steps.map((raw, position) => {
      const text = requireText(raw, `steps[${position}]`, 2000).replace(/\{item:([A-Za-z0-9_-]+)\}/g, (_, key: string) => {
        const id = keyToId.get(key);
        if (!id) throw new RecipeInputError("unknown_item_ref", `Step ${position + 1} references {item:${key}}, but no item has that key.`);
        return `{item:${id}}`;
      });
      return { id: newId("stp"), position, text };
    });

    let mainItemId: string | null = null;
    if (input.mainItemKey) {
      mainItemId = keyToId.get(input.mainItemKey) ?? null;
      if (!mainItemId) throw new RecipeInputError("unknown_item", `mainItemKey "${input.mainItemKey}" does not match any item key.`);
      const main = items.find((i) => i.id === mainItemId)!;
      if (!main.scalable || main.grams <= 0) {
        throw new RecipeInputError("main_not_scalable", "The main ingredient must be scalable and have a quantity.");
      }
    }

    const id = newId("rcp");
    const now = new Date().toISOString();
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO recipes (id, owner_id, title, category, photo_url, base_servings, main_item_id, notes, is_demo, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, this.userId, title, category, photoUrl, servings, mainItemId, notes, now, now);
      this.insertItemsAndSteps(id, items, steps);
    });
    return this.getRecipe(id);
  }

  /**
   * Persists a preview. The preview is recomputed here from the saved recipe and
   * the adjustment, so what gets stored is exactly what the panel showed.
   */
  save(id: string, options: SaveOptions): { recipe: Recipe; mode: "overwrite" | "copy"; originalId: string } {
    const preview = this.preview(id, options.adjustment ?? {});
    const original = this.getRecipe(id);
    const title = options.title !== undefined ? requireText(options.title, "title", 140) : original.title;
    const photoUrl = options.photoUrl !== undefined ? checkPhotoUrl(options.photoUrl) : original.photoUrl;
    const notes = options.notes !== undefined ? optionalText(options.notes, "notes", 2000) : original.notes;
    const category = options.category !== undefined ? checkCategory(options.category) : original.category;
    const now = new Date().toISOString();
    const itemIds = new Set(original.items.map((i) => i.id));
    const stepTexts = options.steps === undefined ? original.steps.map((s) => s.text) : this.checkSteps(options.steps, itemIds);

    if (options.mode === "overwrite") {
      transaction(this.db, () => {
        this.db
          .prepare(`UPDATE recipes SET title = ?, category = ?, photo_url = ?, base_servings = ?, main_item_id = ?, notes = ?, updated_at = ?
            WHERE id = ? AND owner_id = ?`)
          .run(title, category, photoUrl, preview.servings, preview.mainItemId, notes, now, id, this.userId);
        const update = this.db.prepare("UPDATE recipe_items SET ingredient_id = ?, grams = ? WHERE id = ? AND recipe_id = ?");
        for (const item of preview.items) update.run(item.ingredient.id, item.grams, item.id, id);
        if (options.steps !== undefined) {
          this.db.prepare("DELETE FROM recipe_steps WHERE recipe_id = ?").run(id);
          const ins = this.db.prepare("INSERT INTO recipe_steps (id, recipe_id, position, text) VALUES (?, ?, ?, ?)");
          stepTexts.forEach((text, position) => ins.run(newId("stp"), id, position, text));
        }
      });
      return { recipe: this.getRecipe(id), mode: "overwrite", originalId: id };
    }

    if (options.mode !== "copy") throw new RecipeInputError("invalid_mode", 'mode must be "overwrite" or "copy".');
    // Copy: fresh IDs for the recipe, its items and steps; step references are remapped.
    const idMap = new Map(preview.items.map((i) => [i.id, newId("itm")]));
    const items = preview.items.map((i) => ({
      id: idMap.get(i.id)!,
      ingredientId: i.ingredient.id,
      grams: i.grams,
      displayUnit: i.displayUnit,
      scalable: i.scalable,
      position: i.position,
    }));
    const steps = stepTexts.map((text, position) => ({
      id: newId("stp"),
      position,
      text: text.replace(/\{item:([A-Za-z0-9_-]+)\}/g, (m, ref: string) => (idMap.has(ref) ? `{item:${idMap.get(ref)}}` : m)),
    }));
    const copyTitle = options.title !== undefined ? title : `${original.title} (copy)`;
    const newIdValue = newId("rcp");
    transaction(this.db, () => {
      this.db
        .prepare(`INSERT INTO recipes (id, owner_id, title, category, photo_url, base_servings, main_item_id, notes, is_demo, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(newIdValue, this.userId, copyTitle, category, photoUrl, preview.servings,
          preview.mainItemId ? idMap.get(preview.mainItemId)! : null, notes, now, now);
      this.insertItemsAndSteps(newIdValue, items, steps);
    });
    return { recipe: this.getRecipe(newIdValue), mode: "copy", originalId: id };
  }

  private checkSteps(steps: unknown, itemIds: Set<string>): string[] {
    if (!Array.isArray(steps) || steps.length > 60) throw new RecipeInputError("invalid_recipe", "steps must be a list of at most 60 strings.");
    return steps.map((raw, n) => {
      const text = requireText(raw, `steps[${n}]`, 2000);
      for (const ref of stepReferences(text)) {
        if (!itemIds.has(ref)) {
          throw new RecipeInputError("unknown_item_ref", `Step ${n + 1} references {item:${ref}}, which is not an item of this recipe. Use the itemIds from open_recipe.`);
        }
      }
      return text;
    });
  }

  private insertItemsAndSteps(
    recipeId: string,
    items: { id: string; ingredientId: string; grams: number; displayUnit: "g" | "unit"; scalable: boolean; position: number }[],
    steps: { id: string; position: number; text: string }[],
  ): void {
    const insItem = this.db.prepare(`INSERT INTO recipe_items (id, recipe_id, ingredient_id, grams, display_unit, scalable, position) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const i of items) insItem.run(i.id, recipeId, i.ingredientId, i.grams, i.displayUnit, i.scalable ? 1 : 0, i.position);
    const insStep = this.db.prepare("INSERT INTO recipe_steps (id, recipe_id, position, text) VALUES (?, ?, ?, ?)");
    for (const s of steps) {
      for (const ref of stepReferences(s.text)) {
        if (!items.some((i) => i.id === ref)) throw new RecipeInputError("unknown_item_ref", `Step references unknown item ${ref}.`);
      }
      insStep.run(s.id, recipeId, s.position, s.text);
    }
  }

  /** Seeds the clearly labelled demo recipe the first time a user signs in. */
  ensureDemoRecipe(): void {
    const has = this.db.prepare("SELECT 1 FROM recipes WHERE owner_id = ? LIMIT 1").get(this.userId);
    if (has) return;
    const recipe = this.createRecipe(DEMO_RECIPE);
    this.db.prepare("UPDATE recipes SET is_demo = 1 WHERE id = ?").run(recipe.id);
  }
}

/**
 * Demo data so the flow can be tested right away. It is NOT a tested recipe:
 * quantities are illustrative and macros come from the USDA ingredient base.
 */
export const DEMO_RECIPE: NewRecipeInput = {
  title: "DEMO · Coconut chicken curry",
  category: "poultry",
  servings: 4,
  notes: "Demo recipe with sample quantities so you can try scaling, substitutions and saving. Replace it with your own recipes.",
  mainItemKey: "chicken",
  items: [
    { key: "chicken", ingredientId: "chicken-breast-raw", grams: 800 },
    { key: "onion", ingredientId: "onion", units: 2 },
    { key: "garlic", ingredientId: "garlic", units: 4 },
    { key: "ginger", ingredientId: "ginger", grams: 15 },
    { key: "oil", ingredientId: "olive-oil", grams: 15, scalable: false },
    { key: "curry", ingredientId: "curry-powder", grams: 8 },
    { key: "paste", ingredientId: "tomato-paste", grams: 30 },
    { key: "coconut", ingredientId: "coconut-milk-canned", grams: 400 },
    { key: "yogurt", ingredientId: "greek-yogurt-whole", grams: 150 },
    { key: "salt", ingredientId: "salt", grams: 0, scalable: false },
    { key: "cilantro", ingredientId: "cilantro-fresh", grams: 10 },
  ],
  steps: [
    "Cut {item:chicken} into bite-size pieces.",
    "Warm {item:oil} in a wide pan and soften {item:onion}, finely chopped, for 6–8 minutes.",
    "Add {item:garlic}, {item:ginger} and {item:curry}; stir for 1 minute until fragrant.",
    "Stir in {item:paste}, then add the chicken and cook until it is no longer pink outside.",
    "Pour in {item:coconut} and simmer for 15 minutes, until the chicken is cooked through.",
    "Off the heat, stir in {item:yogurt}. Season with {item:salt}.",
    "Finish with {item:cilantro}.",
  ],
};

// ---------- validation helpers ----------

function searchWords(query: string): string[] {
  return query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") throw new RecipeInputError("invalid_text", `${label} is required.`);
  const v = value.trim();
  if (v.length > max) throw new RecipeInputError("invalid_text", `${label} must be at most ${max} characters.`);
  return v;
}

function optionalText(value: unknown, label: string, max: number): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  return requireText(value, label, max);
}

function nonNegative(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RecipeInputError("invalid_number", `${label} must be a number ≥ 0.`);
  }
  if (value > max) throw new RecipeInputError("invalid_number", `${label} must be at most ${max}.`);
  return value;
}

function checkCategory(value: string): RecipeCategory {
  if (!(RECIPE_CATEGORIES as readonly string[]).includes(value)) {
    throw new RecipeInputError("invalid_category", `category must be one of: ${RECIPE_CATEGORIES.join(", ")}.`);
  }
  return value as RecipeCategory;
}

function checkPhotoUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new RecipeInputError("invalid_photo_url", "photoUrl must be a string.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RecipeInputError("invalid_photo_url", "photoUrl must be a valid https:// URL.");
  }
  if (url.protocol !== "https:") throw new RecipeInputError("invalid_photo_url", "photoUrl must use https://.");
  if (value.length > 2000) throw new RecipeInputError("invalid_photo_url", "photoUrl is too long.");
  return url.toString();
}
