import "./zod-jitless";
import "./styles.css";
import { App } from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  RecipeInputError,
  computePreview,
  displayName,
  formatMacros,
  formatQuantity,
  formatServings,
  trimDecimal,
  type Adjustment,
  type IngredientInfo,
  type Macros,
  type Recipe,
  type RecipePreview,
} from "../shared/recipe-math";
import { ingredientThumbnail, recipePlaceholder } from "../shared/placeholders";

// ---------- types coming from the server ----------

interface RecipeSummary {
  id: string;
  title: string;
  category: string;
  photoUrl: string | null;
  servings: number;
  kcalPerServing: number;
  isDemo: boolean;
}

interface Suggestion {
  ingredient: IngredientInfo;
  grams: number;
  macros: Macros;
  diff: Macros;
}

type Payload =
  | { view: "library"; recipes: RecipeSummary[] }
  | {
      view: "recipe";
      recipe: Recipe;
      preview: RecipePreview;
      ingredients: Record<string, IngredientInfo>;
      saved?: { mode: string; recipeId: string; originalId?: string };
    };

const INGREDIENT_CATEGORIES = [
  "poultry", "meat", "seafood", "egg", "plant-protein", "legume", "dairy", "cheese", "grain",
  "pasta", "bread", "starchy-vegetable", "vegetable", "fruit", "nut-seed", "fat-oil",
  "sweetener", "baking", "condiment", "spice", "herb", "drink", "other",
];

// ---------- state ----------

interface Sheet {
  itemId: string;
  loading: boolean;
  error: string | null;
  suggestions: Suggestion[];
  grams: string;
  creating: boolean;
}

const state = {
  view: "loading" as "loading" | "library" | "recipe" | "error",
  recipes: [] as RecipeSummary[],
  recipe: null as Recipe | null,
  ingredients: new Map<string, IngredientInfo>(),
  adjustment: {} as Adjustment,
  preview: null as RecipePreview | null,
  scaleMode: "grams" as "grams" | "servings",
  gramsDraft: "",
  servingsDraft: "",
  controlError: null as string | null,
  pendingPhotoUrl: undefined as string | null | undefined,
  editingPhoto: false,
  checkedItems: new Set<string>(),
  checkedSteps: new Set<string>(),
  sheet: null as Sheet | null,
  copyOpen: false,
  copyTitle: "",
  busy: false,
  notice: null as string | null,
  error: null as string | null,
};

const root = document.getElementById("app")!;
const app = new App({ name: "recipe-notebook-panel", version: "1.0.0" });

// ---------- data flow ----------

function applyPayload(payload: Payload | undefined) {
  if (!payload) return;
  if (payload.view === "library") {
    state.view = "library";
    state.recipes = payload.recipes;
    render();
    return;
  }
  state.view = "recipe";
  state.recipe = payload.recipe;
  for (const [id, ing] of Object.entries(payload.ingredients ?? {})) state.ingredients.set(id, ing);
  state.adjustment = payload.preview.adjustment ?? {};
  state.pendingPhotoUrl = undefined;
  state.editingPhoto = false;
  state.sheet = null;
  state.copyOpen = false;
  state.error = null;
  state.notice = payload.saved
    ? payload.saved.mode === "copy" ? "Saved as a new copy — the original is unchanged." : payload.saved.mode === "create" ? "Recipe created." : "Saved."
    : null;
  state.scaleMode = state.adjustment.servings !== undefined ? "servings" : "grams";
  recompute();
  syncDrafts();
  render();
}

/** Recomputes the preview locally from the saved recipe + adjustment (no tool call). */
function recompute(): boolean {
  if (!state.recipe) return false;
  try {
    state.preview = computePreview(state.recipe, state.adjustment, (id) => state.ingredients.get(id));
    state.controlError = null;
    return true;
  } catch (error) {
    state.controlError = error instanceof RecipeInputError ? error.message : String(error);
    return false;
  }
}

function syncDrafts() {
  const p = state.preview;
  if (!p) return;
  state.gramsDraft = p.mainGrams !== null ? trimDecimal(p.mainGrams, 1) : "";
  state.servingsDraft = trimDecimal(p.servings, 2);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) {
    const text = result.content?.find((c) => c.type === "text");
    throw new Error(text && "text" in text ? text.text : `${name} failed`);
  }
  return result;
}

async function withBusy(fn: () => Promise<void>) {
  state.busy = true;
  state.error = null;
  render();
  try {
    await fn();
  } catch (error) {
    state.error = (error as Error).message;
  } finally {
    state.busy = false;
    render();
  }
}

let contextTimer: number | undefined;
function shareContext() {
  window.clearTimeout(contextTimer);
  contextTimer = window.setTimeout(() => {
    const p = state.preview;
    if (!p || state.view !== "recipe") return;
    const text = p.isModified || state.pendingPhotoUrl !== undefined
      ? `The Recipe Notebook panel shows "${p.title}" (recipeId ${p.recipeId}) with UNSAVED changes. Current adjustment: ${JSON.stringify(state.adjustment)}${state.pendingPhotoUrl !== undefined ? `, new photoUrl: ${JSON.stringify(state.pendingPhotoUrl)}` : ""}. ${formatServings(p.servings)} servings, per serving ${formatMacros(p.perServing)}. To keep it, call save_recipe with this adjustment.`
      : `The Recipe Notebook panel shows "${p.title}" (recipeId ${p.recipeId}) exactly as saved.`;
    app.updateModelContext({ content: [{ type: "text", text }] }).catch(() => {});
  }, 500);
}

// ---------- actions ----------

function setMainGrams(value: number) {
  state.scaleMode = "grams";
  const next: Adjustment = { ...state.adjustment, mainGrams: value };
  delete next.servings;
  // Explicit grams on a substituted main item would conflict with mainGrams.
  const mainId = state.preview?.mainItemId;
  if (next.substitutions && mainId) {
    next.substitutions = next.substitutions.map((s) => (s.itemId === mainId ? { itemId: s.itemId, ingredientId: s.ingredientId } : s));
  }
  commitAdjustment(next);
}

function setServings(value: number) {
  state.scaleMode = "servings";
  const next: Adjustment = { ...state.adjustment, servings: value };
  delete next.mainGrams;
  commitAdjustment(next);
}

function commitAdjustment(next: Adjustment, syncInputs = false) {
  const previous = state.adjustment;
  state.adjustment = normalize(next);
  if (!recompute()) {
    state.adjustment = previous;
    recompute();
    // keep the error message from the rejected adjustment
    try {
      computePreview(state.recipe!, next, (id) => state.ingredients.get(id));
    } catch (error) {
      state.controlError = (error as Error).message;
    }
  } else if (syncInputs) {
    syncDrafts();
  } else {
    // keep the field being typed in, refresh the other one
    const p = state.preview!;
    if (state.scaleMode === "grams") state.servingsDraft = trimDecimal(p.servings, 2);
    else state.gramsDraft = p.mainGrams !== null ? trimDecimal(p.mainGrams, 1) : "";
  }
  state.notice = null;
  render();
  shareContext();
}

function normalize(a: Adjustment): Adjustment {
  const out: Adjustment = {};
  if (a.mainGrams !== undefined) out.mainGrams = a.mainGrams;
  if (a.servings !== undefined) out.servings = a.servings;
  if (a.mainItemId !== undefined && a.mainItemId !== state.recipe?.mainItemId) out.mainItemId = a.mainItemId;
  if (a.substitutions?.length) out.substitutions = a.substitutions;
  return out;
}

function changeMainItem(itemId: string) {
  const p = state.preview!;
  const item = state.recipe!.items.find((i) => i.id === itemId)!;
  const next: Adjustment = { ...state.adjustment, mainItemId: itemId };
  // keep the current scale when the main ingredient changes
  if (state.scaleMode === "grams" && next.mainGrams !== undefined) next.mainGrams = item.grams * p.factor;
  commitAdjustment(next, true);
}

function step(kind: "grams" | "servings", dir: 1 | -1) {
  const p = state.preview;
  if (!p) return;
  if (kind === "grams") {
    const current = p.mainGrams ?? 0;
    const inc = current >= 500 ? 50 : current >= 100 ? 25 : current >= 20 ? 5 : 1;
    const value = Math.max(inc, Math.round((current + dir * inc) / inc) * inc);
    setMainGrams(value);
  } else {
    const inc = p.servings > 2 || (p.servings === 2 && dir > 0) ? 1 : 0.5;
    const value = Math.max(0.5, Math.round((p.servings + dir * inc) / inc) * inc);
    setServings(value);
  }
  syncDrafts();
  render();
}

function onDraft(kind: "grams" | "servings", raw: string) {
  if (kind === "grams") state.gramsDraft = raw;
  else state.servingsDraft = raw;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value <= 0) {
    state.controlError = kind === "grams" ? "Enter the main ingredient's grams (greater than 0)." : "Enter servings greater than 0.";
    render();
    return;
  }
  if (kind === "grams") setMainGrams(value);
  else setServings(value);
}

async function openSheet(itemId: string) {
  state.sheet = { itemId, loading: true, error: null, suggestions: [], grams: "", creating: false };
  render();
  try {
    const res = await callTool("suggest_substitutes", { recipeId: state.recipe!.id, itemId, ...state.adjustment, presentation: "list" });
    const data = res.structuredContent as { suggestions: Suggestion[]; grams: number };
    for (const s of data.suggestions) state.ingredients.set(s.ingredient.id, s.ingredient);
    if (state.sheet?.itemId === itemId) {
      state.sheet = { ...state.sheet, loading: false, suggestions: data.suggestions, grams: trimDecimal(data.grams, 1) };
    }
  } catch (error) {
    if (state.sheet?.itemId === itemId) state.sheet = { ...state.sheet, loading: false, error: (error as Error).message };
  }
  render();
}

function applySubstitution(itemId: string, ingredientId: string) {
  const sheet = state.sheet;
  const p = state.preview!;
  const item = p.items.find((i) => i.id === itemId)!;
  const subs = (state.adjustment.substitutions ?? []).filter((s) => s.itemId !== itemId);
  const gramsValue = sheet ? Number(sheet.grams) : NaN;
  const sub: { itemId: string; ingredientId: string; grams?: number } = { itemId, ingredientId };
  if (Number.isFinite(gramsValue) && gramsValue > 0 && Math.abs(gramsValue - item.grams) > 0.05) sub.grams = gramsValue;
  const original = state.recipe!.items.find((i) => i.id === itemId)!;
  if (ingredientId !== original.ingredient.id || sub.grams !== undefined) subs.push(sub);
  state.sheet = null;
  commitAdjustment({ ...state.adjustment, substitutions: subs }, true);
}

function undoSubstitution(itemId: string) {
  const subs = (state.adjustment.substitutions ?? []).filter((s) => s.itemId !== itemId);
  commitAdjustment({ ...state.adjustment, substitutions: subs }, true);
}

async function createIngredient(form: HTMLFormElement) {
  const fd = new FormData(form);
  const num = (k: string) => (fd.get(k) === "" || fd.get(k) === null ? undefined : Number(fd.get(k)));
  const text = (k: string) => (String(fd.get(k) ?? "").trim() || undefined);
  const args = {
    name: text("name"), brand: text("brand") ?? null, category: text("category"),
    kcal100g: num("kcal100g"), protein100g: num("protein100g"), carbs100g: num("carbs100g"), fat100g: num("fat100g"),
    gramsPerUnit: num("gramsPerUnit") ?? null, unitName: text("unitName") ?? null,
  };
  const itemId = state.sheet!.itemId;
  await withBusy(async () => {
    const res = await callTool("create_ingredient", args);
    const created = (res.structuredContent as { ingredient: IngredientInfo }).ingredient;
    state.ingredients.set(created.id, created);
    applySubstitution(itemId, created.id);
    state.notice = `Created ${displayName(created)} and used it in the preview.`;
  });
}

async function save(mode: "overwrite" | "copy") {
  const recipeId = state.recipe!.id;
  const args: Record<string, unknown> = { recipeId, mode, ...state.adjustment };
  if (state.pendingPhotoUrl !== undefined) args.photoUrl = state.pendingPhotoUrl;
  if (mode === "copy") args.title = state.copyTitle.trim() || undefined;
  await withBusy(async () => {
    const res = await callTool("save_recipe", args);
    applyPayload(res.structuredContent as Payload);
  });
}

async function openRecipe(recipeId: string) {
  await withBusy(async () => {
    const res = await callTool("open_recipe", { recipeId });
    applyPayload(res.structuredContent as Payload);
  });
}

async function showLibrary() {
  await withBusy(async () => {
    const res = await callTool("list_recipes", {});
    state.view = "library";
    state.recipes = (res.structuredContent as { recipes: RecipeSummary[] }).recipes;
  });
}

function defaultCopyTitle(): string {
  const p = state.preview!;
  if (state.adjustment.mainGrams !== undefined && p.mainGrams !== null) return `${p.title} — ${Math.round(p.mainGrams)} g`;
  if (state.adjustment.servings !== undefined) return `${p.title} — ${formatServings(p.servings)} servings`;
  return `${p.title} (copy)`;
}

// ---------- rendering ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CHECK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7"/></svg>';

function photoSrc(url: string | null, category: string) {
  return url ? esc(url) : recipePlaceholder(category);
}

function diffText(d: Macros) {
  const sign = (n: number) => (n >= 0 ? "+" : "−");
  return `${sign(d.kcal)}${Math.round(Math.abs(d.kcal))} kcal · ${sign(d.protein)}${trimDecimal(Math.abs(d.protein), 1)} P · ${sign(d.carbs)}${trimDecimal(Math.abs(d.carbs), 1)} C · ${sign(d.fat)}${trimDecimal(Math.abs(d.fat), 1)} F`;
}

function renderLibrary(): string {
  if (!state.recipes.length) return `<p class="empty">No recipes yet — ask ChatGPT to save one for you.</p>`;
  return `
    <h1 class="library-title">My recipes</h1>
    <ul class="cards">
      ${state.recipes.map((r) => `
        <li><button class="card" data-action="open" data-id="${esc(r.id)}">
          <img src="${photoSrc(r.photoUrl, r.category)}" alt="" data-fallback="${esc(r.category)}">
          <strong>${esc(r.title)}</strong>
          <span>${formatServings(r.servings)} servings · ${Math.round(r.kcalPerServing)} kcal</span>
        </button></li>`).join("")}
    </ul>`;
}

function renderRecipe(): string {
  const p = state.preview!;
  const r = state.recipe!;
  const photo = state.pendingPhotoUrl !== undefined ? state.pendingPhotoUrl : p.photoUrl;
  const mainCandidates = r.items.filter((i) => i.scalable && i.grams > 0);
  const main = p.items.find((i) => i.isMain);
  const unsaved = p.isModified || state.pendingPhotoUrl !== undefined;

  const macro = (label: string, value: string) => `<div class="macro"><b>${value}</b><span>${label}</span></div>`;

  return `
    <div class="topbar">
      <button class="link" data-action="library">← All recipes</button>
      ${p.isDemo ? '<span class="demo-badge" title="Sample data for testing">demo data</span>' : ""}
    </div>
    <section class="hero">
      <div>
        <figure class="polaroid" style="margin:10px 0 0">
          <span class="tape" aria-hidden="true"></span>
          <img src="${photoSrc(photo ?? null, p.category)}" alt="${esc(p.title)}" data-fallback="${esc(p.category)}">
          <figcaption class="caption">${esc(p.category)}</figcaption>
        </figure>
        ${state.editingPhoto
          ? `<form class="inline-field" data-form="photo"><input name="url" type="url" placeholder="https://…" value="${esc(photo ?? "")}" aria-label="Photo URL"><button class="icon-btn">Use</button></form>`
          : `<button class="link photo-edit" data-action="edit-photo">${photo ? "Change photo" : "Add photo URL"}</button>`}
      </div>
      <div class="title-block">
        <h1>${esc(p.title)}</h1>
        <div class="annotation">✎ for ${formatServings(p.servings)} serving${p.servings === 1 ? "" : "s"}${Math.abs(p.factor - 1) > 1e-9 ? ` <span class="annotation small">(×${trimDecimal(p.factor, 3)} of the saved recipe)</span>` : ""}</div>
        <div class="macro-head">Per serving</div>
        <div class="macros" aria-label="Macros per serving">
          ${macro("kcal", String(Math.round(p.perServing.kcal)))}
          ${macro("protein", `${trimDecimal(p.perServing.protein, 1)} g`)}
          ${macro("carbs", `${trimDecimal(p.perServing.carbs, 1)} g`)}
          ${macro("fat", `${trimDecimal(p.perServing.fat, 1)} g`)}
        </div>
        <div class="macro-total">Whole recipe: ${formatMacros(p.totals)}</div>
        ${p.notes ? `<p class="notes">${esc(p.notes)}</p>` : ""}
      </div>
    </section>

    <hr class="rule">

    <section class="controls" aria-label="Scale the recipe">
      <div class="control">
        <label for="main">Main ingredient</label>
        <select id="main" data-input="main" ${mainCandidates.length ? "" : "disabled"}>
          ${mainCandidates.length ? "" : '<option value="">No scalable ingredient</option>'}
          ${p.mainItemId === null && mainCandidates.length ? '<option value="" selected>None — scale by servings</option>' : ""}
          ${mainCandidates.map((i) => {
            const shown = p.items.find((x) => x.id === i.id)!;
            return `<option value="${esc(i.id)}" ${i.id === p.mainItemId ? "selected" : ""}>${esc(displayName(shown.ingredient))}</option>`;
          }).join("")}
        </select>
      </div>
      <div class="control">
        <label for="grams">Main ingredient grams</label>
        <div class="stepper ${state.scaleMode === "grams" ? "active" : ""}">
          <button data-action="step" data-kind="grams" data-dir="-1" aria-label="Less" ${main ? "" : "disabled"}>−</button>
          <input id="grams" data-input="grams" type="number" inputmode="decimal" min="0" step="any" value="${esc(state.gramsDraft)}" ${main ? "" : "disabled"}>
          <span class="unit">g</span>
          <button data-action="step" data-kind="grams" data-dir="1" aria-label="More" ${main ? "" : "disabled"}>+</button>
        </div>
      </div>
      <div class="control">
        <label for="servings">Servings</label>
        <div class="stepper ${state.scaleMode === "servings" ? "active" : ""}">
          <button data-action="step" data-kind="servings" data-dir="-1" aria-label="Fewer servings">−</button>
          <input id="servings" data-input="servings" type="number" inputmode="decimal" min="0" step="any" value="${esc(state.servingsDraft)}">
          <button data-action="step" data-kind="servings" data-dir="1" aria-label="More servings">+</button>
        </div>
      </div>
    </section>
    ${state.controlError ? `<div class="field-error" role="alert">${esc(state.controlError)}</div>` : ""}

    <h2>Ingredients</h2>
    <ul class="items">
      ${p.items.map((i) => {
        const done = state.checkedItems.has(i.id);
        const changed = i.quantityChanged || i.substitutedFrom !== null;
        const qty = formatQuantity(i);
        return `
        <li class="item ${done ? "done" : ""}">
          <label class="check"><input type="checkbox" data-input="check-item" data-id="${esc(i.id)}" ${done ? "checked" : ""} aria-label="Have ${esc(i.ingredient.name)}">${CHECK}</label>
          <div class="item-text">
            ${qty === "to taste"
              ? `<span class="${i.substitutedFrom ? "mark" : ""}">${esc(displayName(i.ingredient))}</span> <span class="annotation small">to taste</span>`
              : `<span class="qty ${changed ? "mark" : ""}">${esc(qty)}</span> <span class="${i.substitutedFrom ? "mark" : ""}">${esc(displayName(i.ingredient))}</span>`}
            ${i.isMain ? '<span class="badge">★ main</span>' : ""}
            ${i.scalable ? "" : '<span class="fixed">fixed</span>'}
            ${i.substitutedFrom ? `<span class="was">was ${esc(displayName(i.substitutedFrom))}</span>` : ""}
          </div>
          <div>
            ${i.substitutedFrom || (state.adjustment.substitutions ?? []).some((s) => s.itemId === i.id)
              ? `<button class="icon-btn" data-action="undo-sub" data-id="${esc(i.id)}">Undo</button>`
              : `<button class="icon-btn" data-action="sub" data-id="${esc(i.id)}" aria-label="Substitute ${esc(i.ingredient.name)}">⇄ Swap</button>`}
          </div>
        </li>
        ${state.sheet?.itemId === i.id ? renderSheet(i) : ""}`;
      }).join("")}
    </ul>

    <h2>Steps</h2>
    <ol class="steps">
      ${p.steps.map((s, n) => {
        const done = state.checkedSteps.has(s.id);
        return `
        <li class="step ${done ? "done" : ""}">
          <span class="step-num">${n + 1}</span>
          <div class="step-text">${s.segments.map((seg) =>
            seg.type === "text" ? esc(seg.text)
              : `<span class="ref ${seg.changed ? "mark" : ""} ${seg.missing ? "missing" : ""}">${esc(seg.label)}</span>`).join("")}</div>
          <label class="check"><input type="checkbox" data-input="check-step" data-id="${esc(s.id)}" ${done ? "checked" : ""} aria-label="Step ${n + 1} done">${CHECK}</label>
        </li>`;
      }).join("")}
    </ol>
    ${p.steps.length ? "" : '<p class="empty">No steps yet.</p>'}

    <div class="savebar"><div class="savebar-inner">
      <div class="status"><span class="dot ${unsaved ? "unsaved" : ""}"></span>${
        state.notice && !unsaved ? `<span class="notice">${esc(state.notice)}</span>` : unsaved ? "Unsaved changes — this is a preview" : "Saved"}</div>
      ${unsaved ? '<button class="btn-ghost" data-action="reset" ' + (state.busy ? "disabled" : "") + ">Reset</button>" : ""}
      <button class="btn terra" data-action="copy" ${state.busy ? "disabled" : ""}>Save copy</button>
      <button class="btn primary" data-action="save" ${!unsaved || state.busy ? "disabled" : ""}>Save</button>
      ${state.copyOpen ? `
        <form class="copy-row" data-form="copy">
          <input name="title" value="${esc(state.copyTitle)}" aria-label="Title for the copy" maxlength="140" required>
          <button class="btn primary" ${state.busy ? "disabled" : ""}>Save as copy</button>
          <button type="button" class="btn-ghost" data-action="copy-cancel">Cancel</button>
        </form>` : ""}
    </div></div>
  `;
}

function renderSheet(item: RecipePreview["items"][number]): string {
  const s = state.sheet!;
  return `
    <li class="sheet" aria-label="Substitutes">
      <div class="sheet-head">
        <h3>Swap ${esc(displayName(item.ingredient))}</h3>
        <button class="btn-ghost" data-action="close-sheet">Close</button>
      </div>
      ${s.loading ? '<p class="annotation small">Looking for substitutes…</p>' : ""}
      ${s.error ? `<div class="error-box">${esc(s.error)}</div>` : ""}
      ${!s.loading && !s.error ? `
        <div class="inline-field"><label for="sub-grams">Amount</label>
          <input id="sub-grams" data-input="sub-grams" type="number" min="0" step="any" value="${esc(s.grams)}"> g
          <span class="fixed">differences below are for ${Math.round(item.grams)} g</span></div>
        <ul class="options">
          ${s.suggestions.map((o) => `
            <li class="option">
              <img src="${ingredientThumbnail(o.ingredient.category)}" alt="">
              <div><strong>${esc(displayName(o.ingredient))}</strong><small>${diffText(o.diff)}</small></div>
              <button class="icon-btn" data-action="apply-sub" data-id="${esc(o.ingredient.id)}">Use</button>
            </li>`).join("")}
          ${s.suggestions.length ? "" : '<li class="annotation small">No close matches — create the ingredient below.</li>'}
        </ul>
        ${s.creating ? `
          <form class="form-grid" data-form="create-ingredient">
            <label class="wide">Name<input name="name" required maxlength="120"></label>
            <label>Brand (optional)<input name="brand" maxlength="80"></label>
            <label>Category<select name="category">${INGREDIENT_CATEGORIES.map((c) => `<option ${c === item.ingredient.category ? "selected" : ""}>${c}</option>`).join("")}</select></label>
            <label>kcal / 100 g<input name="kcal100g" type="number" min="0" max="900" step="any" required></label>
            <label>Protein g / 100 g<input name="protein100g" type="number" min="0" max="100" step="any" required></label>
            <label>Carbs g / 100 g<input name="carbs100g" type="number" min="0" max="100" step="any" required></label>
            <label>Fat g / 100 g<input name="fat100g" type="number" min="0" max="100" step="any" required></label>
            <label>Grams per unit (optional)<input name="gramsPerUnit" type="number" min="0" step="any"></label>
            <label>Unit name (optional)<input name="unitName" maxlength="40" placeholder="bar, slice…"></label>
            <div class="wide"><button class="btn primary" ${state.busy ? "disabled" : ""}>Create &amp; use</button></div>
          </form>` : '<button class="link" data-action="show-create">Not listed? Create an ingredient (e.g. a branded product)</button>'}
      ` : ""}
    </li>`;
}

function render() {
  const active = document.activeElement as HTMLInputElement | null;
  const focusKey = active?.dataset?.input ?? active?.getAttribute?.("name") ?? null;
  const selection = active && "selectionStart" in active ? [active.selectionStart, active.selectionEnd] : null;

  let html = "";
  if (state.view === "loading") html = '<p class="loading">Opening your notebook…</p>';
  else if (state.view === "library") html = renderLibrary();
  else if (state.view === "recipe" && state.preview) html = renderRecipe();
  else html = `<p class="empty">Something went wrong.</p>`;
  if (state.error) html = `<div class="error-box" role="alert">${esc(state.error)}</div>` + html;
  root.innerHTML = html;

  root.querySelectorAll<HTMLImageElement>("img[data-fallback]").forEach((img) => {
    img.addEventListener("error", () => {
      img.src = recipePlaceholder(img.dataset.fallback ?? "other");
    }, { once: true });
  });

  if (focusKey) {
    const el = root.querySelector<HTMLInputElement>(`[data-input="${focusKey}"], [name="${focusKey}"]`);
    if (el) {
      el.focus();
      if (selection && el.type !== "number" && el.setSelectionRange) {
        try { el.setSelectionRange(selection[0], selection[1]); } catch { /* not all inputs support it */ }
      }
    }
  }
}

// ---------- events ----------

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || (target as HTMLButtonElement).disabled) return;
  const id = target.dataset.id ?? "";
  switch (target.dataset.action) {
    case "open": void openRecipe(id); break;
    case "library": void showLibrary(); break;
    case "step": step(target.dataset.kind as "grams" | "servings", Number(target.dataset.dir) as 1 | -1); break;
    case "sub": void openSheet(id); break;
    case "undo-sub": undoSubstitution(id); break;
    case "close-sheet": state.sheet = null; render(); break;
    case "apply-sub": applySubstitution(state.sheet!.itemId, id); break;
    case "show-create": state.sheet!.creating = true; render(); break;
    case "reset": state.adjustment = {}; state.pendingPhotoUrl = undefined; state.scaleMode = "grams"; recompute(); syncDrafts(); render(); shareContext(); break;
    case "save": void save("overwrite"); break;
    case "copy": state.copyOpen = true; state.copyTitle = defaultCopyTitle(); render(); break;
    case "copy-cancel": state.copyOpen = false; render(); break;
    case "edit-photo": state.editingPhoto = true; render(); break;
  }
});

root.addEventListener("input", (event) => {
  const el = event.target as HTMLInputElement;
  switch (el.dataset.input) {
    case "grams": onDraft("grams", el.value); break;
    case "servings": onDraft("servings", el.value); break;
    case "sub-grams": if (state.sheet) state.sheet.grams = el.value; break;
  }
  if (el.name === "title" && el.closest("[data-form=copy]")) state.copyTitle = el.value;
});

root.addEventListener("change", (event) => {
  const el = event.target as HTMLInputElement;
  switch (el.dataset.input) {
    case "main": if (el.value) changeMainItem(el.value); break;
    case "check-item": toggle(state.checkedItems, el.dataset.id!, el.checked); break;
    case "check-step": toggle(state.checkedSteps, el.dataset.id!, el.checked); break;
    case "grams": case "servings": syncDrafts(); render(); break;
  }
});

root.addEventListener("submit", (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  switch (form.dataset.form) {
    case "copy": void save("copy"); break;
    case "create-ingredient": void createIngredient(form); break;
    case "photo": {
      const url = String(new FormData(form).get("url") ?? "").trim();
      state.pendingPhotoUrl = url === "" ? null : url;
      state.editingPhoto = false;
      render();
      shareContext();
      break;
    }
  }
});

function toggle(set: Set<string>, id: string, on: boolean) {
  if (on) set.add(id);
  else set.delete(id);
  render();
}

// ---------- boot ----------

app.ontoolresult = (params) => applyPayload(params.structuredContent as Payload | undefined);

app.connect().catch((error) => {
  state.view = "error";
  state.error = `Could not connect to the host: ${(error as Error).message}`;
  render();
});
