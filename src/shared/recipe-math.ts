// Pure recipe math shared by the MCP server and the notebook panel.
// Everything here works on full-precision numbers; rounding happens only in the
// format* helpers at display time.

export const RECIPE_CATEGORIES = [
  "poultry", "meat", "seafood", "vegetarian", "vegan", "pasta", "rice", "salad",
  "soup", "breakfast", "dessert", "baking", "drink", "other",
] as const;
export type RecipeCategory = (typeof RECIPE_CATEGORIES)[number];

export interface IngredientInfo {
  id: string;
  name: string;
  brand: string | null;
  category: string;
  state: string | null;
  kcal100g: number;
  protein100g: number;
  carbs100g: number;
  fat100g: number;
  gramsPerUnit: number | null;
  unitName: string | null;
  custom: boolean;
}

export interface RecipeItem {
  id: string;
  ingredient: IngredientInfo;
  grams: number;
  displayUnit: "g" | "unit";
  scalable: boolean;
  position: number;
}

export interface RecipeStep {
  id: string;
  position: number;
  text: string;
}

export interface Recipe {
  id: string;
  title: string;
  category: RecipeCategory;
  photoUrl: string | null;
  baseServings: number;
  mainItemId: string | null;
  notes: string | null;
  isDemo: boolean;
  items: RecipeItem[];
  steps: RecipeStep[];
  updatedAt: string;
}

export interface SubstitutionInput {
  itemId: string;
  ingredientId: string;
  /** Quantity in the adjusted recipe. Omit to keep the item's current grams. */
  grams?: number;
}

/**
 * A preview is always described relative to the saved recipe, never relative to
 * a previous preview, so applying the same adjustment twice gives the same result.
 */
export interface Adjustment {
  mainGrams?: number;
  servings?: number;
  mainItemId?: string | null;
  substitutions?: SubstitutionInput[];
}

export interface Macros {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface PreviewItem {
  id: string;
  ingredient: IngredientInfo;
  grams: number;
  baseGrams: number;
  displayUnit: "g" | "unit";
  scalable: boolean;
  position: number;
  isMain: boolean;
  substitutedFrom: IngredientInfo | null;
  quantityChanged: boolean;
  macros: Macros;
}

export type StepSegment =
  | { type: "text"; text: string }
  | { type: "item"; itemId: string; label: string; changed: boolean; missing: boolean };

export interface PreviewStep {
  id: string;
  position: number;
  segments: StepSegment[];
  text: string;
}

export interface RecipePreview {
  recipeId: string;
  title: string;
  category: RecipeCategory;
  photoUrl: string | null;
  notes: string | null;
  isDemo: boolean;
  baseServings: number;
  servings: number;
  factor: number;
  mainItemId: string | null;
  mainGrams: number | null;
  items: PreviewItem[];
  steps: PreviewStep[];
  totals: Macros;
  perServing: Macros;
  adjustment: Adjustment;
  isModified: boolean;
}

export class RecipeInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RecipeInputError";
  }
}

export const LIMITS = {
  maxGrams: 100_000,
  maxServings: 500,
  minServings: 0.25,
};

const EPSILON = 1e-9;

export function assertPositiveNumber(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RecipeInputError("invalid_number", `${label} must be a number.`);
  }
  if (value <= 0) throw new RecipeInputError("invalid_number", `${label} must be greater than 0.`);
  if (value > max) throw new RecipeInputError("invalid_number", `${label} must be at most ${max}.`);
  return value;
}

export function macrosFor(ingredient: IngredientInfo, grams: number): Macros {
  const f = grams / 100;
  return {
    kcal: ingredient.kcal100g * f,
    protein: ingredient.protein100g * f,
    carbs: ingredient.carbs100g * f,
    fat: ingredient.fat100g * f,
  };
}

export function addMacros(a: Macros, b: Macros): Macros {
  return { kcal: a.kcal + b.kcal, protein: a.protein + b.protein, carbs: a.carbs + b.carbs, fat: a.fat + b.fat };
}

export function subtractMacros(a: Macros, b: Macros): Macros {
  return { kcal: a.kcal - b.kcal, protein: a.protein - b.protein, carbs: a.carbs - b.carbs, fat: a.fat - b.fat };
}

export function divideMacros(a: Macros, by: number): Macros {
  return { kcal: a.kcal / by, protein: a.protein / by, carbs: a.carbs / by, fat: a.fat / by };
}

const ZERO: Macros = { kcal: 0, protein: 0, carbs: 0, fat: 0 };

/** Resolves the scale factor for an adjustment against the saved recipe. */
function resolveFactor(
  recipe: Recipe,
  adjustment: Adjustment,
  mainItemId: string | null,
  mainSubGrams: number | undefined,
): number {
  const hasGrams = adjustment.mainGrams !== undefined && adjustment.mainGrams !== null;
  const hasServings = adjustment.servings !== undefined && adjustment.servings !== null;
  if (hasGrams && hasServings) {
    throw new RecipeInputError(
      "ambiguous_scale",
      "Choose one way to scale: either mainGrams or servings, not both.",
    );
  }
  if (hasServings) {
    const servings = assertPositiveNumber(adjustment.servings, "servings", LIMITS.maxServings);
    if (servings < LIMITS.minServings) {
      throw new RecipeInputError("invalid_number", `servings must be at least ${LIMITS.minServings}.`);
    }
    return servings / recipe.baseServings;
  }
  // Substitution grams only change that one item; they never rescale the recipe.
  if (!hasGrams) return 1;
  const target = assertPositiveNumber(adjustment.mainGrams, "mainGrams", LIMITS.maxGrams);
  if (mainSubGrams !== undefined && Math.abs(mainSubGrams - target) > EPSILON) {
    throw new RecipeInputError(
      "ambiguous_scale",
      `mainGrams (${target}) and the grams given for the substituted main ingredient (${mainSubGrams}) disagree. Send only one of them.`,
    );
  }
  if (!mainItemId) {
    throw new RecipeInputError(
      "no_main_ingredient",
      "This recipe has no main ingredient. Scale it by servings, or pick a main ingredient first.",
    );
  }
  const main = recipe.items.find((i) => i.id === mainItemId)!;
  if (!main.scalable) {
    throw new RecipeInputError("main_not_scalable", `The main ingredient "${main.ingredient.name}" is marked as not scalable.`);
  }
  if (main.grams <= 0) {
    throw new RecipeInputError("main_without_grams", `The main ingredient "${main.ingredient.name}" has no saved quantity to scale from.`);
  }
  return target / main.grams;
}

/**
 * Builds a preview of `recipe` with `adjustment` applied. `lookupIngredient`
 * resolves ingredient IDs used by substitutions (server: database; panel: cache).
 */
export function computePreview(
  recipe: Recipe,
  adjustment: Adjustment = {},
  lookupIngredient: (id: string) => IngredientInfo | undefined = () => undefined,
): RecipePreview {
  const itemsById = new Map(recipe.items.map((i) => [i.id, i]));

  let mainItemId = recipe.mainItemId;
  if (adjustment.mainItemId !== undefined) {
    if (adjustment.mainItemId !== null && !itemsById.has(adjustment.mainItemId)) {
      throw new RecipeInputError("unknown_item", `mainItemId "${adjustment.mainItemId}" is not an item of this recipe.`);
    }
    mainItemId = adjustment.mainItemId;
  }

  const subs = new Map<string, { ingredient: IngredientInfo; grams?: number }>();
  for (const sub of adjustment.substitutions ?? []) {
    const item = itemsById.get(sub.itemId);
    if (!item) throw new RecipeInputError("unknown_item", `Item "${sub.itemId}" is not part of this recipe.`);
    if (subs.has(sub.itemId)) {
      throw new RecipeInputError("duplicate_substitution", `Item "${sub.itemId}" is substituted more than once.`);
    }
    const ingredient = lookupIngredient(sub.ingredientId);
    if (!ingredient) throw new RecipeInputError("unknown_ingredient", `Ingredient "${sub.ingredientId}" was not found.`);
    let grams: number | undefined;
    if (sub.grams !== undefined && sub.grams !== null) {
      grams = assertPositiveNumber(sub.grams, `grams for ${ingredient.name}`, LIMITS.maxGrams);
    }
    subs.set(sub.itemId, { ingredient, grams });
  }

  const mainSubGrams = mainItemId ? subs.get(mainItemId)?.grams : undefined;
  const factor = resolveFactor(recipe, adjustment, mainItemId, mainSubGrams);

  let totals = ZERO;
  const items: PreviewItem[] = [...recipe.items]
    .sort((a, b) => a.position - b.position)
    .map((item) => {
      const scaled = item.scalable ? item.grams * factor : item.grams;
      const sub = subs.get(item.id);
      const grams = sub?.grams ?? scaled;
      const ingredient = sub?.ingredient ?? item.ingredient;
      const macros = macrosFor(ingredient, grams);
      totals = addMacros(totals, macros);
      return {
        id: item.id,
        ingredient,
        grams,
        baseGrams: item.grams,
        displayUnit: item.displayUnit,
        scalable: item.scalable,
        position: item.position,
        isMain: item.id === mainItemId,
        substitutedFrom: sub && sub.ingredient.id !== item.ingredient.id ? item.ingredient : null,
        quantityChanged: Math.abs(grams - item.grams) > EPSILON,
        macros,
      };
    });

  const servings = recipe.baseServings * factor;
  const previewItems = new Map(items.map((i) => [i.id, i]));
  const steps = [...recipe.steps]
    .sort((a, b) => a.position - b.position)
    .map((step) => renderStep(step, previewItems));

  const normalized: Adjustment = {};
  if (adjustment.mainGrams !== undefined && adjustment.mainGrams !== null) normalized.mainGrams = adjustment.mainGrams;
  if (adjustment.servings !== undefined && adjustment.servings !== null) normalized.servings = adjustment.servings;
  if (adjustment.mainItemId !== undefined && adjustment.mainItemId !== recipe.mainItemId) {
    normalized.mainItemId = adjustment.mainItemId;
  }
  const realSubs = (adjustment.substitutions ?? []).filter((s) => {
    const item = itemsById.get(s.itemId)!;
    return s.ingredientId !== item.ingredient.id || (s.grams !== undefined && s.grams !== null);
  });
  if (realSubs.length) normalized.substitutions = realSubs.map((s) => ({ ...s }));

  const mainItem = mainItemId ? previewItems.get(mainItemId) : undefined;
  return {
    recipeId: recipe.id,
    title: recipe.title,
    category: recipe.category,
    photoUrl: recipe.photoUrl,
    notes: recipe.notes,
    isDemo: recipe.isDemo,
    baseServings: recipe.baseServings,
    servings,
    factor,
    mainItemId,
    mainGrams: mainItem ? mainItem.grams : null,
    items,
    steps,
    totals,
    perServing: divideMacros(totals, servings),
    adjustment: normalized,
    isModified:
      Math.abs(factor - 1) > EPSILON ||
      normalized.substitutions !== undefined ||
      normalized.mainItemId !== undefined,
  };
}

export const ITEM_REF = /\{item:([A-Za-z0-9_-]+)\}/g;

export function renderStep(step: RecipeStep, items: Map<string, PreviewItem>): PreviewStep {
  const segments: StepSegment[] = [];
  let last = 0;
  for (const match of step.text.matchAll(ITEM_REF)) {
    if (match.index > last) segments.push({ type: "text", text: step.text.slice(last, match.index) });
    const item = items.get(match[1]);
    segments.push(
      item
        ? {
            type: "item",
            itemId: item.id,
            label: stepLabel(item),
            changed: item.quantityChanged || item.substitutedFrom !== null,
            missing: false,
          }
        : { type: "item", itemId: match[1], label: "[removed ingredient]", changed: false, missing: true },
    );
    last = match.index + match[0].length;
  }
  if (last < step.text.length) segments.push({ type: "text", text: step.text.slice(last) });
  return {
    id: step.id,
    position: step.position,
    segments,
    text: segments.map((s) => (s.type === "text" ? s.text : s.label)).join(""),
  };
}

/** Item IDs referenced by a step's text. */
export function stepReferences(text: string): string[] {
  return [...text.matchAll(ITEM_REF)].map((m) => m[1]);
}

// ---------- Display formatting (rounding happens only here) ----------

export function formatGrams(grams: number): string {
  if (grams === 0) return "0 g";
  if (grams < 10) return `${trimDecimal(grams, 1)} g`;
  return `${Math.round(grams).toLocaleString("en-US")} g`;
}

const FRACTIONS: Record<number, string> = { 0.25: "¼", 0.5: "½", 0.75: "¾" };

export function formatCount(count: number): string {
  const quarters = Math.round(count * 4) / 4;
  if (quarters === 0) return trimDecimal(count, 2);
  const whole = Math.floor(quarters);
  const frac = FRACTIONS[quarters - whole];
  if (!frac) return String(whole);
  return whole === 0 ? frac : `${whole}${frac}`;
}

export function formatQuantity(item: Pick<PreviewItem, "grams" | "displayUnit" | "scalable" | "ingredient">): string {
  if (item.grams === 0 && !item.scalable) return "to taste";
  const { gramsPerUnit, unitName } = item.ingredient;
  if (item.displayUnit === "unit" && gramsPerUnit && unitName) {
    const count = item.grams / gramsPerUnit;
    const plural = count > 1 + EPSILON ? pluralize(unitName) : unitName;
    return `${formatCount(count)} ${plural} (${formatGrams(item.grams)})`;
  }
  return formatGrams(item.grams);
}

export function itemLabel(item: Pick<PreviewItem, "grams" | "displayUnit" | "scalable" | "ingredient">): string {
  const qty = formatQuantity(item);
  const name = displayName(item.ingredient);
  return qty === "to taste" ? `${name} (to taste)` : `${qty} ${name}`;
}

/** Shorter label for step text: "800 g Chicken breast", "2 onions (220 g)", "Salt (to taste)". */
export function stepLabel(item: Pick<PreviewItem, "grams" | "displayUnit" | "scalable" | "ingredient">): string {
  const ing = item.ingredient;
  const name = ing.brand ? displayName(ing) : ing.custom ? ing.name : ing.name.split(",")[0].trim();
  if (item.grams === 0 && !item.scalable) return `${name} (to taste)`;
  if (item.displayUnit === "unit" && ing.gramsPerUnit && ing.unitName) {
    const count = item.grams / ing.gramsPerUnit;
    const unit = count > 1 + EPSILON ? pluralize(ing.unitName) : ing.unitName;
    const head = `${formatCount(count)} ${unit}`;
    return name.toLowerCase() === ing.unitName.toLowerCase()
      ? `${head} (${formatGrams(item.grams)})`
      : `${head} ${name} (${formatGrams(item.grams)})`;
  }
  return `${formatGrams(item.grams)} ${name}`;
}

export function displayName(ingredient: Pick<IngredientInfo, "name" | "brand">): string {
  return ingredient.brand ? `${ingredient.name} (${ingredient.brand})` : ingredient.name;
}

export function formatMacros(m: Macros): string {
  return `${Math.round(m.kcal)} kcal · ${trimDecimal(m.protein, 1)} g protein · ${trimDecimal(m.carbs, 1)} g carbs · ${trimDecimal(m.fat, 1)} g fat`;
}

export function formatServings(servings: number): string {
  return trimDecimal(servings, 2);
}

export function trimDecimal(value: number, digits: number): string {
  const s = value.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function pluralize(word: string): string {
  if (/(s|x|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]o$/.test(word)) return `${word}es`;
  return `${word}s`;
}
