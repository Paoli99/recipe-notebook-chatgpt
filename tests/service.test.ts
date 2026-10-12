import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createUser } from "../src/server/auth.js";
import { RecipeService } from "../src/server/recipes.js";
import { RecipeInputError, stepReferences } from "../src/shared/recipe-math.js";

function setup() {
  const db = openDatabase(":memory:");
  const alice = createUser(db, "alice@example.com", "password-a");
  const bob = createUser(db, "bob@example.com", "password-b");
  const a = new RecipeService(db, alice.id);
  const b = new RecipeService(db, bob.id);
  a.ensureDemoRecipe();
  b.ensureDemoRecipe();
  const demoId = a.listRecipes()[0].id;
  return { db, a, b, demoId };
}

test("curated ingredient base is loaded with 100–150 USDA items and sources", () => {
  const { db } = setup();
  const row = db.prepare("SELECT count(*) AS n FROM ingredients WHERE owner_id IS NULL").get() as { n: number };
  assert.ok(row.n >= 100 && row.n <= 150, `got ${row.n}`);
  const chicken = db.prepare("SELECT * FROM ingredients WHERE id = 'chicken-breast-raw'").get() as Record<string, unknown>;
  assert.equal(chicken.kcal_100g, 120);
  assert.match(String(chicken.source), /"fdcId":171077/);
  const cooked = db.prepare("SELECT kcal_100g FROM ingredients WHERE id = 'chicken-breast-roasted'").get() as { kcal_100g: number };
  assert.equal(cooked.kcal_100g, 165);
});

test("the demo recipe is labelled and uses the 800 g main ingredient", () => {
  const { a, demoId } = setup();
  const r = a.getRecipe(demoId);
  assert.ok(r.isDemo);
  assert.match(r.title, /^DEMO/);
  const main = r.items.find((i) => i.id === r.mainItemId)!;
  assert.equal(main.grams, 800);
});

test("adjusting does not modify the persisted recipe", () => {
  const { a, demoId } = setup();
  const before = JSON.stringify(a.getRecipe(demoId));
  const p = a.preview(demoId, { mainGrams: 100 });
  assert.equal(p.factor, 0.125);
  const yogurt = p.items.find((i) => i.ingredient.id === "greek-yogurt-whole")!;
  a.preview(demoId, { substitutions: [{ itemId: yogurt.id, ingredientId: "sour-cream" }] });
  a.suggestSubstitutes(demoId, yogurt.id, { mainGrams: 100 });
  assert.equal(JSON.stringify(a.getRecipe(demoId)), before);
});

test("save overwrite then reopen returns exactly what was saved", () => {
  const { a, demoId } = setup();
  const r = a.getRecipe(demoId);
  const yogurt = r.items.find((i) => i.ingredient.id === "greek-yogurt-whole")!;
  const adjustment = { mainGrams: 333, substitutions: [{ itemId: yogurt.id, ingredientId: "sour-cream" }] };
  const preview = a.preview(demoId, adjustment);
  const { recipe } = a.save(demoId, { mode: "overwrite", adjustment });
  assert.equal(recipe.id, demoId);
  const reopened = a.preview(demoId);
  assert.equal(reopened.isModified, false);
  assert.deepEqual(reopened.items.map((i) => [i.id, i.ingredient.id, i.grams]), preview.items.map((i) => [i.id, i.ingredient.id, i.grams]));
  assert.equal(reopened.servings, preview.servings);
  assert.deepEqual(reopened.totals, preview.totals);
  assert.deepEqual(reopened.steps.map((s) => s.text), preview.steps.map((s) => s.text));
  // full precision persisted (333/800 × 300 g yogurt … not rounded)
  const salt = reopened.items.find((i) => i.ingredient.id === "salt")!;
  assert.equal(salt.grams, 0);
  assert.equal(reopened.items.find((i) => i.isMain)!.grams, 333);
});

test("save as copy leaves the original untouched and keeps step references valid", () => {
  const { a, demoId } = setup();
  const before = JSON.stringify(a.getRecipe(demoId));
  const { recipe: copy } = a.save(demoId, { mode: "copy", adjustment: { servings: 2 }, title: "Curry for two" });
  assert.notEqual(copy.id, demoId);
  assert.equal(copy.title, "Curry for two");
  assert.equal(copy.isDemo, false);
  assert.equal(copy.baseServings, 2);
  assert.equal(JSON.stringify(a.getRecipe(demoId)), before);
  const copyItemIds = new Set(copy.items.map((i) => i.id));
  const originalItemIds = new Set(a.getRecipe(demoId).items.map((i) => i.id));
  for (const step of copy.steps) {
    for (const ref of stepReferences(step.text)) {
      assert.ok(copyItemIds.has(ref), `step ref ${ref} must point at the copy`);
      assert.ok(!originalItemIds.has(ref));
    }
  }
  assert.ok(copy.mainItemId && copyItemIds.has(copy.mainItemId));
  const p = a.preview(copy.id);
  assert.ok(!p.steps.some((s) => s.text.includes("[removed ingredient]")));
});

test("a user cannot read or modify another user's recipes", () => {
  const { a, b, demoId } = setup();
  assert.throws(() => b.getRecipe(demoId), (e: unknown) => e instanceof RecipeInputError && e.code === "not_found");
  assert.throws(() => b.preview(demoId, { mainGrams: 10 }), /not found/);
  assert.throws(() => b.save(demoId, { mode: "overwrite", adjustment: { mainGrams: 10 } }), /not found/);
  assert.throws(() => b.save(demoId, { mode: "copy" }), /not found/);
  assert.ok(!b.listRecipes().some((r) => r.id === demoId));
  assert.equal(a.getRecipe(demoId).items.find((i) => i.ingredient.id === "chicken-breast-raw")!.grams, 800);
});

test("custom ingredients are private to their owner", () => {
  const { a, b, demoId } = setup();
  const bar = a.createIngredient({ name: "Protein bar", brand: "Acme", category: "other", kcal100g: 380, protein100g: 33, carbs100g: 40, fat100g: 12, gramsPerUnit: 60, unitName: "bar" });
  assert.ok(bar.custom);
  assert.equal(a.searchIngredients("protein bar")[0]?.id, bar.id);
  assert.equal(b.searchIngredients("protein bar").length, 0);
  assert.equal(b.getIngredient(bar.id), undefined);
  // Bob can't use Alice's ingredient in his own recipe
  const bobDemo = b.listRecipes()[0].id;
  const bobItem = b.getRecipe(bobDemo).items[0].id;
  assert.throws(() => b.preview(bobDemo, { substitutions: [{ itemId: bobItem, ingredientId: bar.id }] }), /was not found/);
  assert.throws(() => b.createRecipe({ title: "x", servings: 1, items: [{ key: "a", ingredientId: bar.id, grams: 10 }], steps: [] }), /was not found/);
  // Alice can
  const aliceItem = a.getRecipe(demoId).items[0].id;
  const p = a.preview(demoId, { substitutions: [{ itemId: aliceItem, ingredientId: bar.id }] });
  assert.equal(p.items[0].ingredient.brand, "Acme");
});

test("substitute suggestions show macro differences for the quantity used", () => {
  const { a, demoId } = setup();
  const r = a.getRecipe(demoId);
  const chicken = r.items.find((i) => i.ingredient.id === "chicken-breast-raw")!;
  const { suggestions, item } = a.suggestSubstitutes(demoId, chicken.id, { mainGrams: 100 });
  assert.equal(item.grams, 100);
  assert.ok(suggestions.length > 0);
  for (const s of suggestions) {
    assert.equal(s.grams, 100);
    assert.ok(Math.abs(s.diff.kcal - (s.ingredient.kcal100g - 120)) < 1e-9);
  }
  assert.equal(suggestions[0].ingredient.category, "poultry");
});

test("creating a recipe maps step keys to item IDs and validates input", () => {
  const { a } = setup();
  const r = a.createRecipe({
    title: "Omelette", category: "breakfast", servings: 1, mainItemKey: "eggs",
    items: [
      { key: "eggs", ingredientId: "egg-whole-raw", units: 3 },
      { key: "cheese", ingredientId: "cheddar", grams: 30 },
      { key: "salt", ingredientId: "salt", grams: 0, scalable: false },
    ],
    steps: ["Beat {item:eggs} with {item:salt}.", "Fold in {item:cheese}."],
  });
  const p = a.preview(r.id);
  assert.equal(p.steps[0].text, "Beat 3 eggs (150 g) with Salt (to taste).");
  assert.throws(() => a.createRecipe({ title: "x", servings: 1, items: [{ key: "a", ingredientId: "salt", grams: 1 }], steps: ["Use {item:b}"] }), /no item has that key/);
  assert.throws(() => a.createRecipe({ title: "x", servings: 1, items: [{ key: "a", ingredientId: "salt", grams: 1, units: 2 }], steps: [] }), /either grams or units/);
  assert.throws(() => a.createRecipe({ title: "", servings: 1, items: [{ key: "a", ingredientId: "salt", grams: 1 }], steps: [] }), /title is required/);
  assert.throws(() => a.createRecipe({ title: "x", servings: 1, photoUrl: "http://insecure.example/a.jpg", items: [{ key: "a", ingredientId: "salt", grams: 1 }], steps: [] }), /https/);
  assert.throws(() => a.createIngredient({ name: "Bad", category: "other", kcal100g: 100, protein100g: 60, carbs100g: 50, fat100g: 10 }), /cannot exceed 100 g/);
});

test("recipe and ingredient search match every word, in any order", () => {
  const { a, demoId } = setup();
  assert.deepEqual(a.listRecipes("coconut curry").map((r) => r.id), [demoId]);
  assert.equal(a.listRecipes("curry pizza").length, 0);
  const summary = a.listRecipes()[0];
  assert.equal(summary.mainGrams, 800);
  assert.match(summary.mainIngredient ?? "", /Chicken breast/);
  assert.ok(a.searchIngredients("yogurt greek").some((i) => i.id === "greek-yogurt-whole"));
});

test("saving can replace step text; references are validated and remapped on copy", () => {
  const { a, demoId } = setup();
  const r = a.getRecipe(demoId);
  const main = r.mainItemId!;
  const steps = [`Cut {item:${main}} and cook it.`, "Serve warm."];
  a.save(demoId, { mode: "overwrite", steps });
  assert.deepEqual(a.getRecipe(demoId).steps.map((s) => s.text), steps);
  assert.throws(() => a.save(demoId, { mode: "overwrite", steps: ["Use {item:itm_nope}"] }), /not an item of this recipe/);
  const { recipe: copy } = a.save(demoId, { mode: "copy", steps: [`Only {item:${main}}.`] });
  assert.equal(copy.steps.length, 1);
  assert.equal(copy.steps[0].text, `Only {item:${copy.mainItemId}}.`);
  assert.equal(a.getRecipe(demoId).steps.length, 2);
});
