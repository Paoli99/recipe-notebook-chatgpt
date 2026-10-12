import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RecipeInputError,
  computePreview,
  formatQuantity,
  type IngredientInfo,
  type Recipe,
} from "../src/shared/recipe-math.js";

const ing = (id: string, kcal: number, p: number, c: number, f: number, extra: Partial<IngredientInfo> = {}): IngredientInfo => ({
  id, name: id, brand: null, category: "other", state: null,
  kcal100g: kcal, protein100g: p, carbs100g: c, fat100g: f, gramsPerUnit: null, unitName: null, custom: false, ...extra,
});

const chicken = ing("chicken", 120, 22.5, 0, 2.62, { category: "poultry" });
const tofu = ing("tofu", 144, 17.3, 2.8, 8.7, { category: "plant-protein" });
const rice = ing("rice", 365, 7.1, 80, 0.7);
const salt = ing("salt", 0, 0, 0, 0);
const oil = ing("oil", 884, 0, 0, 100);
const egg = ing("egg", 143, 12.6, 0.7, 9.5, { gramsPerUnit: 50, unitName: "egg" });

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "r1", title: "Test", category: "poultry", photoUrl: null, baseServings: 4, mainItemId: "i1",
    notes: null, isDemo: false, updatedAt: "",
    items: [
      { id: "i1", ingredient: chicken, grams: 800, displayUnit: "g", scalable: true, position: 0 },
      { id: "i2", ingredient: rice, grams: 300, displayUnit: "g", scalable: true, position: 1 },
      { id: "i3", ingredient: oil, grams: 15, displayUnit: "g", scalable: false, position: 2 },
      { id: "i4", ingredient: salt, grams: 0, displayUnit: "g", scalable: false, position: 3 },
      { id: "i5", ingredient: egg, grams: 100, displayUnit: "unit", scalable: true, position: 4 },
    ],
    steps: [
      { id: "s1", position: 0, text: "Cook {item:i1} with {item:i3}." },
      { id: "s2", position: 1, text: "Add {item:i2} and {item:i5}. Season with {item:i4}." },
    ],
    ...overrides,
  };
}

const lookup = (id: string) => [chicken, tofu, rice, salt, oil, egg].find((i) => i.id === id);
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("scaling the main ingredient from 800 g to 100 g applies factor 0.125", () => {
  const p = computePreview(recipe(), { mainGrams: 100 });
  close(p.factor, 0.125);
  close(p.items[0].grams, 100);
  close(p.items[1].grams, 37.5);
  close(p.items[4].grams, 12.5);
  close(p.servings, 0.5);
});

test("non-scalable items keep their quantity", () => {
  const p = computePreview(recipe(), { mainGrams: 100 });
  close(p.items[2].grams, 15);
  close(p.items[3].grams, 0);
  assert.equal(formatQuantity(p.items[3]), "to taste");
});

test("scaling by servings updates ingredients and macros", () => {
  const base = computePreview(recipe());
  const p = computePreview(recipe(), { servings: 6 });
  close(p.factor, 1.5);
  close(p.items[0].grams, 1200);
  close(p.items[2].grams, 15);
  // totals: scalable items ×1.5, oil unchanged
  const scalableKcal = base.totals.kcal - (884 * 15) / 100;
  close(p.totals.kcal, scalableKcal * 1.5 + (884 * 15) / 100);
  close(p.perServing.kcal, p.totals.kcal / 6);
  // macros recomputed from per-100 g values
  close(p.items[0].macros.protein, 22.5 * 12);
});

test("ambiguous input (both mainGrams and servings) is rejected", () => {
  assert.throws(() => computePreview(recipe(), { mainGrams: 100, servings: 2 }), (e: unknown) =>
    e instanceof RecipeInputError && e.code === "ambiguous_scale");
});

test("invalid numbers produce clear errors", () => {
  assert.throws(() => computePreview(recipe(), { mainGrams: 0 }), /mainGrams must be greater than 0/);
  assert.throws(() => computePreview(recipe(), { servings: -2 }), /servings must be greater than 0/);
  assert.throws(() => computePreview(recipe(), { mainGrams: Number.NaN }), /mainGrams must be a number/);
  assert.throws(() => computePreview(recipe(), { substitutions: [{ itemId: "nope", ingredientId: "tofu" }] }, lookup), /not part of this recipe/);
  assert.throws(() => computePreview(recipe(), { substitutions: [{ itemId: "i1", ingredientId: "ghost" }] }, lookup), /was not found/);
});

test("without a main ingredient, servings scaling works and grams scaling is refused", () => {
  const r = recipe({ mainItemId: null });
  const p = computePreview(r, { servings: 2 });
  close(p.items[0].grams, 400);
  assert.equal(p.mainGrams, null);
  assert.throws(() => computePreview(r, { mainGrams: 100 }), (e: unknown) => e instanceof RecipeInputError && e.code === "no_main_ingredient");
});

test("substitution keeps grams, updates macros and the rendered steps", () => {
  const p = computePreview(recipe(), { substitutions: [{ itemId: "i1", ingredientId: "tofu" }] }, lookup);
  const item = p.items[0];
  assert.equal(item.ingredient.id, "tofu");
  assert.equal(item.substitutedFrom?.id, "chicken");
  close(item.grams, 800);
  close(item.macros.kcal, 144 * 8);
  const base = computePreview(recipe());
  close(p.totals.kcal - base.totals.kcal, (144 - 120) * 8);
  assert.equal(p.steps[0].text, "Cook 800 g tofu with 15 g oil.");
  assert.equal(computePreview(recipe()).steps[1].text, "Add 300 g rice and 2 eggs (100 g). Season with salt (to taste).");
  assert.ok(p.isModified);
});

test("substitution with explicit grams changes only that item; scaling combines with it", () => {
  const p = computePreview(recipe(), { mainGrams: 400, substitutions: [{ itemId: "i2", ingredientId: "rice", grams: 120 }] }, lookup);
  close(p.items[0].grams, 400);
  close(p.items[1].grams, 120);
  close(p.items[4].grams, 50);
  assert.match(p.steps[1].text, /^Add 120 g rice and 1 egg \(50 g\)/);
});

test("conflicting grams for a substituted main ingredient are rejected", () => {
  assert.throws(() => computePreview(recipe(), { mainGrams: 400, substitutions: [{ itemId: "i1", ingredientId: "tofu", grams: 300 }] }, lookup),
    (e: unknown) => e instanceof RecipeInputError && e.code === "ambiguous_scale");
});

test("successive adjustments start from the saved recipe (no compounding)", () => {
  const r = recipe();
  const once = computePreview(r, { mainGrams: 400 });
  const again = computePreview(r, once.adjustment);
  close(again.factor, 0.5);
  close(again.items[1].grams, once.items[1].grams);
  const then = computePreview(r, { mainGrams: 100 });
  close(then.factor, 0.125); // not 0.5 × 0.125
});

test("precision is kept internally; rounding only happens when formatting", () => {
  const p = computePreview(recipe(), { mainGrams: 333 });
  close(p.items[1].grams, (300 * 333) / 800);
  assert.equal(formatQuantity(p.items[1]), "125 g");
  assert.equal(formatQuantity({ ...p.items[1], grams: 3.333 }), "3.3 g");
});

test("unit items render as counts with grams", () => {
  const p = computePreview(recipe(), { servings: 6 });
  assert.equal(formatQuantity(p.items[4]), "3 eggs (150 g)");
  const half = computePreview(recipe(), { mainGrams: 100 });
  assert.equal(formatQuantity(half.items[4]), "¼ egg (13 g)");
});

test("missing step references are shown, not crashed on", () => {
  const r = recipe({ steps: [{ id: "s", position: 0, text: "Use {item:gone}." }] });
  const p = computePreview(r);
  assert.equal(p.steps[0].text, "Use [removed ingredient].");
});
