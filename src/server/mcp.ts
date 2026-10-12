import type { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { OpenAIUiResourceMetadata, OpenAIUiToolMetadata } from "@openai/mcp-extensions/server";
import {
  RECIPE_CATEGORIES,
  RecipeInputError,
  displayName,
  formatMacros,
  formatServings,
  itemLabel,
  type Adjustment,
  type IngredientInfo,
  type Recipe,
  type RecipePreview,
} from "../shared/recipe-math.js";
import { ingredientThumbnail } from "../shared/placeholders.js";
import { INGREDIENT_CATEGORIES, RecipeService, type NewIngredientInput } from "./recipes.js";
import { askForm, type FormField } from "./forms.js";
import { SCOPE } from "./auth.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PANEL_URI = "ui://recipe-notebook/notebook-v1.html";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export interface McpOptions {
  db: DatabaseSync;
  photoDomains: string[];
}

function loadPanelHtml(): string {
  try {
    return readFileSync(resolve(ROOT, "dist/panel/index.html"), "utf8");
  } catch {
    return `<!doctype html><html><body style="font-family:system-ui;padding:16px">
      <p>The notebook panel has not been built yet. Run <code>npm run build</code> and restart the server.</p></body></html>`;
  }
}

// ---------- shared input schemas ----------

const substitution = z.object({
  itemId: z.string().describe("ID of the recipe item to replace (from open_recipe)."),
  ingredientId: z.string().describe("ID of the replacement ingredient (from suggest_substitutes or search_ingredients)."),
  grams: z.number().positive().max(100_000).optional()
    .describe("Quantity of the replacement in the adjusted recipe. Omit to keep the replaced item's grams."),
});

const adjustmentShape = {
  mainGrams: z.number().positive().max(100_000).optional()
    .describe("Scale the whole recipe so the main ingredient weighs this many grams. Do not combine with servings."),
  servings: z.number().min(0.25).max(500).optional()
    .describe("Scale the whole recipe to this many servings. Do not combine with mainGrams."),
  mainItemId: z.string().nullable().optional().describe("Use a different item as the main ingredient for this preview."),
  substitutions: z.array(substitution).max(80).optional()
    .describe("Full list of substitutions for this preview. Each call replaces the previous list; it is not cumulative."),
};

const newRecipeSchema = z.object({
  title: z.string().min(1).max(140),
  category: z.enum(RECIPE_CATEGORIES).optional(),
  photoUrl: z.string().max(2000).nullable().optional().describe("https:// URL of a photo. Omit to use an illustrated placeholder."),
  servings: z.number().positive().max(500),
  notes: z.string().max(2000).nullable().optional(),
  mainItemKey: z.string().nullable().optional().describe("key of the main ingredient item (drives scaling by grams)."),
  items: z.array(z.object({
    key: z.string().min(1).max(60).describe("Short key used to reference this item in steps, e.g. 'chicken'."),
    ingredientId: z.string(),
    grams: z.number().min(0).max(100_000).optional().describe("Quantity in grams. Use 0 with scalable=false for 'to taste'."),
    units: z.number().positive().max(1000).optional().describe("Quantity in units (e.g. 2 eggs) for ingredients that have a unit weight."),
    scalable: z.boolean().optional().describe("false keeps the quantity fixed when the recipe is scaled (e.g. salt, oil for the pan). Default true."),
  })).min(1).max(80),
  steps: z.array(z.string().min(1).max(2000)).max(60)
    .describe("Steps. Reference ingredients as {item:key} so quantities stay correct when scaling or substituting."),
});

// ---------- result helpers ----------

function errorResult(error: unknown): CallToolResult {
  if (error instanceof RecipeInputError) {
    return { isError: true, content: [{ type: "text", text: `Error (${error.code}): ${error.message}` }] };
  }
  throw error;
}

function previewText(p: RecipePreview, heading: string): string {
  const lines = [
    `${heading}: ${p.title}${p.isDemo ? " (demo data)" : ""} [recipeId: ${p.recipeId}]`,
    `Servings: ${formatServings(p.servings)}${p.isModified ? ` (saved recipe: ${formatServings(p.baseServings)})` : ""}`,
    `Per serving: ${formatMacros(p.perServing)}`,
    `Total: ${formatMacros(p.totals)}`,
    "",
    "Ingredients:",
    ...p.items.map((i) =>
      `- ${itemLabel(i)} [itemId: ${i.id}]${i.isMain ? " (main)" : ""}${i.substitutedFrom ? ` (replaces ${displayName(i.substitutedFrom)})` : ""}${i.scalable ? "" : " (fixed)"}`),
    "",
    "Steps:",
    ...p.steps.map((s, n) => `${n + 1}. ${s.text}`),
  ];
  if (p.isModified) {
    lines.push("", `This is an unsaved preview. Adjustment: ${JSON.stringify(p.adjustment)}. Call save_recipe with the same adjustment and mode "overwrite" or "copy" to keep it.`);
  }
  return lines.join("\n");
}

function ingredientMap(recipe: Recipe, preview: RecipePreview, extra: IngredientInfo[] = []): Record<string, IngredientInfo> {
  const map: Record<string, IngredientInfo> = {};
  for (const i of recipe.items) map[i.ingredient.id] = i.ingredient;
  for (const i of preview.items) map[i.ingredient.id] = i.ingredient;
  for (const i of extra) map[i.id] = i;
  return map;
}

function notebookResult(service: RecipeService, recipeId: string, adjustment: Adjustment, heading: string, extraMeta: Record<string, unknown> = {}): CallToolResult {
  const recipe = service.getRecipe(recipeId);
  const preview = service.preview(recipeId, adjustment);
  return {
    content: [{ type: "text", text: previewText(preview, heading) }],
    structuredContent: { view: "recipe", recipe, preview, ingredients: ingredientMap(recipe, preview), ...extraMeta },
  };
}

function adjustmentFrom(args: { mainGrams?: number; servings?: number; mainItemId?: string | null; substitutions?: z.infer<typeof substitution>[] }): Adjustment {
  const a: Adjustment = {};
  if (args.mainGrams !== undefined) a.mainGrams = args.mainGrams;
  if (args.servings !== undefined) a.servings = args.servings;
  if (args.mainItemId !== undefined) a.mainItemId = args.mainItemId;
  if (args.substitutions !== undefined) a.substitutions = args.substitutions;
  return a;
}

function macroDiffText(d: { kcal: number; protein: number; carbs: number; fat: number }): string {
  const f = (n: number, unit: string) => `${n >= 0 ? "+" : "−"}${unit === "kcal" ? Math.round(Math.abs(n)) : Math.abs(n).toFixed(1).replace(/\.0$/, "")}${unit === "kcal" ? " kcal" : ` g ${unit}`}`;
  return `${f(d.kcal, "kcal")}, ${f(d.protein, "protein")}, ${f(d.carbs, "carbs")}, ${f(d.fat, "fat")}`;
}

function defaultCopyTitle(p: RecipePreview): string {
  if (p.adjustment.mainGrams !== undefined && p.mainGrams !== null) return `${p.title} — ${Math.round(p.mainGrams)} g`;
  if (p.adjustment.servings !== undefined) return `${p.title} — ${formatServings(p.servings)} servings`;
  return `${p.title} (copy)`;
}

const AUTH = [{ type: "oauth2", scopes: [SCOPE] }];

/**
 * Creates one MCP server instance (one per HTTP session). Every tool resolves
 * the user from the verified access token in `extra.authInfo`.
 */
export function buildMcpServer({ db, photoDomains }: McpOptions): McpServer {
  const server = new McpServer({ name: "recipe-notebook", version: "1.0.0" }, {
    instructions:
      "Recipe Notebook stores the user's recipes. Use open_recipe to show a recipe in the notebook panel (optionally scaled by mainGrams OR servings). " +
      "Adjustments and substitutions are previews: they are only saved when save_recipe is called with mode 'overwrite' or 'copy'. " +
      "Every adjustment is relative to the saved recipe; pass the complete adjustment each time. Never invent nutrition values: they come from the ingredient database.",
  });

  const serviceFor = (extra: Extra): RecipeService => {
    const userId = extra.authInfo?.extra?.userId;
    if (typeof userId !== "string") throw new Error("Unauthenticated request reached a tool handler");
    return new RecipeService(db, userId);
  };

  const uiMeta = (entrypoints: OpenAIUiToolMetadata["entrypoints"] = []) => ({
    ui: { resourceUri: PANEL_URI },
    ...(entrypoints.length ? { "openai/ui": { entrypoints } satisfies OpenAIUiToolMetadata } : {}),
  });

  server.registerResource(
    "recipe-notebook-panel",
    PANEL_URI,
    { title: "Recipe Notebook panel", description: "Notebook-style recipe viewer and editor", mimeType: RESOURCE_MIME_TYPE },
    async () => ({
      contents: [{
        uri: PANEL_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: loadPanelHtml(),
        _meta: {
          ui: {
            prefersBorder: false,
            csp: { resourceDomains: ["https://fonts.googleapis.com", "https://fonts.gstatic.com", ...photoDomains] },
          },
          "openai/ui": {
            availableDisplayModes: ["inline", "fullscreen"],
            preferredDisplayMode: "inline",
          } satisfies OpenAIUiResourceMetadata,
        },
      }],
    }),
  );

  // ---------- list_recipes ----------
  server.registerTool("list_recipes", {
    title: "List recipes",
    description: "List the user's saved recipes, optionally filtered by a text query on the title.",
    inputSchema: { query: z.string().max(100).optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query }, extra) => {
    try {
      const recipes = serviceFor(extra).listRecipes(query ?? "");
      const text = recipes.length
        ? recipes.map((r) => `- ${r.title} [recipeId: ${r.id}] · ${formatServings(r.servings)} servings · ${Math.round(r.kcalPerServing)} kcal/serving${r.mainIngredient ? ` · main: ${Math.round(r.mainGrams ?? 0)} g ${r.mainIngredient}` : ""}${r.isDemo ? " (demo)" : ""}`).join("\n")
        : query ? `No recipes match "${query}".` : "No recipes saved yet.";
      return { content: [{ type: "text", text }], structuredContent: { recipes } };
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- open_recipe ----------
  server.registerTool("open_recipe", {
    title: "Open recipe",
    description:
      "Open a recipe in the notebook panel. Optionally preview it scaled by the main ingredient's grams (mainGrams) or by servings — never both. " +
      "Without recipeId, shows the recipe library. Nothing is saved.",
    inputSchema: {
      recipeId: z.string().optional(),
      mainGrams: adjustmentShape.mainGrams,
      servings: adjustmentShape.servings,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiMeta([{ type: "thread" }]),
  }, async ({ recipeId, mainGrams, servings }, extra) => {
    try {
      const service = serviceFor(extra);
      if (!recipeId) {
        const recipes = service.listRecipes();
        return {
          content: [{ type: "text", text: `Showing the recipe library (${recipes.length} recipes).` }],
          structuredContent: { view: "library", recipes },
        };
      }
      return notebookResult(service, recipeId, adjustmentFrom({ mainGrams, servings }), "Opened");
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- adjust_recipe ----------
  server.registerTool("adjust_recipe", {
    title: "Preview adjustments",
    description:
      "Preview a recipe scaled (mainGrams OR servings) and/or with substitutions, recalculating quantities, step text and macros. " +
      "The preview is NOT saved. Always pass the full adjustment relative to the saved recipe.",
    inputSchema: { recipeId: z.string(), ...adjustmentShape },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: uiMeta(),
  }, async ({ recipeId, ...rest }, extra) => {
    try {
      return notebookResult(serviceFor(extra), recipeId, adjustmentFrom(rest), "Preview (not saved)");
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- suggest_substitutes ----------
  server.registerTool("suggest_substitutes", {
    title: "Suggest substitutes",
    description:
      "Suggest replacements for one recipe item, with macro differences for the quantity used in the (adjusted) recipe. " +
      "When the client supports forms, asks the user to pick one and returns the updated preview (not saved).",
    inputSchema: {
      recipeId: z.string(),
      itemId: z.string(),
      ...adjustmentShape,
      presentation: z.enum(["form", "list"]).optional().describe("'list' returns suggestions without asking. Default 'form'."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ recipeId, itemId, presentation, ...rest }, extra) => {
    try {
      const service = serviceFor(extra);
      const adjustment = adjustmentFrom(rest);
      const { item, suggestions } = service.suggestSubstitutes(recipeId, itemId, adjustment);
      const listText = [
        `Substitutes for ${itemLabel(item)} [itemId: ${item.id}] — differences are for ${Math.round(item.grams)} g:`,
        ...suggestions.map((s) => `- ${displayName(s.ingredient)} [ingredientId: ${s.ingredient.id}]: ${macroDiffText(s.diff)}`),
      ].join("\n");
      const data = { recipeId, itemId, grams: item.grams, current: item.ingredient, suggestions };

      if (presentation !== "list" && suggestions.length) {
        const options = suggestions.map((s) => ({
          const: s.ingredient.id,
          title: displayName(s.ingredient),
          description: `${macroDiffText(s.diff)} for ${Math.round(s.grams)} g`,
          thumbnail: ingredientThumbnail(s.ingredient.category),
        }));
        const fields: Record<string, FormField> = {
          ingredientId: { kind: "choice", title: `Replace ${displayName(item.ingredient)} with`, options, required: true },
          grams: { kind: "number", title: "Grams (leave as is to keep the same amount)", min: 0.1, max: 100_000, default: Math.round(item.grams * 10) / 10 },
        };
        const answer = await askForm(server, extra, `Choose a substitute for ${itemLabel(item)}`, fields);
        if (answer.status === "accepted") {
          const chosen = String(answer.values.ingredientId);
          const grams = typeof answer.values.grams === "number" && Math.abs(answer.values.grams - item.grams) > 0.05 ? answer.values.grams : undefined;
          const subs = (adjustment.substitutions ?? []).filter((s) => s.itemId !== itemId);
          subs.push({ itemId, ingredientId: chosen, ...(grams !== undefined ? { grams } : {}) });
          const next = { ...adjustment, substitutions: subs };
          const result = notebookResult(service, recipeId, next, "Preview with substitution (not saved)");
          return result;
        }
        if (answer.status === "declined") {
          return { content: [{ type: "text", text: "The user closed the substitution form without choosing. Nothing changed." }], structuredContent: data };
        }
        // Forms unsupported: fall through to the plain list.
      }
      return {
        content: [{ type: "text", text: `${listText}\n\nTo preview one, call adjust_recipe with substitutions: [{ itemId: "${item.id}", ingredientId: "<id>" }] plus the current adjustment.` }],
        structuredContent: data,
      };
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- search_ingredients ----------
  server.registerTool("search_ingredients", {
    title: "Search ingredients",
    description: "Search the ingredient database (curated USDA base plus the user's custom ingredients). Values are per 100 g.",
    inputSchema: {
      query: z.string().max(100).describe("Text to match against the name or brand. Empty string lists by category."),
      category: z.enum(INGREDIENT_CATEGORIES).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ query, category, limit }, extra) => {
    try {
      const results = serviceFor(extra).searchIngredients(query, category, limit ?? 20);
      const text = results.length
        ? results.map((i) => `- ${displayName(i)} [ingredientId: ${i.id}] (${i.category}${i.state ? `, ${i.state}` : ""}${i.custom ? ", custom" : ""}) per 100 g: ${Math.round(i.kcal100g)} kcal, P ${i.protein100g} g, C ${i.carbs100g} g, F ${i.fat100g} g${i.gramsPerUnit ? ` · 1 ${i.unitName} = ${i.gramsPerUnit} g` : ""}`).join("\n")
        : `No ingredients match "${query}". You can create one with create_ingredient.`;
      return { content: [{ type: "text", text }], structuredContent: { ingredients: results } };
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- create_ingredient ----------
  server.registerTool("create_ingredient", {
    title: "Create ingredient",
    description:
      "Create a custom ingredient (e.g. a branded product) visible only to this user, with nutrition per 100 g taken from the label. " +
      "Never estimate values: if they are unknown, omit them and the user will be asked (when forms are supported).",
    inputSchema: {
      name: z.string().max(120).optional(),
      brand: z.string().max(80).nullable().optional(),
      category: z.enum(INGREDIENT_CATEGORIES).optional(),
      state: z.string().max(30).nullable().optional().describe("e.g. raw, cooked, dry, canned"),
      kcal100g: z.number().min(0).max(900).optional(),
      protein100g: z.number().min(0).max(100).optional(),
      carbs100g: z.number().min(0).max(100).optional(),
      fat100g: z.number().min(0).max(100).optional(),
      gramsPerUnit: z.number().positive().max(5000).nullable().optional(),
      unitName: z.string().max(40).nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args, extra) => {
    try {
      const required = ["name", "category", "kcal100g", "protein100g", "carbs100g", "fat100g"] as const;
      let input: Partial<NewIngredientInput> = { ...args };
      const missing = required.filter((k) => input[k] === undefined || input[k] === null || input[k] === "");
      if (missing.length) {
        const fields: Record<string, FormField> = {
          name: { kind: "text", title: "Name", required: true, default: args.name },
          brand: { kind: "text", title: "Brand (optional)", default: args.brand ?? undefined },
          category: { kind: "choice", title: "Category", required: true, default: args.category, options: INGREDIENT_CATEGORIES.map((c) => ({ const: c, title: c })) },
          kcal100g: { kind: "number", title: "Calories per 100 g", required: true, min: 0, max: 900, default: args.kcal100g },
          protein100g: { kind: "number", title: "Protein (g) per 100 g", required: true, min: 0, max: 100, default: args.protein100g },
          carbs100g: { kind: "number", title: "Carbs (g) per 100 g", required: true, min: 0, max: 100, default: args.carbs100g },
          fat100g: { kind: "number", title: "Fat (g) per 100 g", required: true, min: 0, max: 100, default: args.fat100g },
          gramsPerUnit: { kind: "number", title: "Grams per unit (optional)", min: 0.1, max: 5000, default: args.gramsPerUnit ?? undefined },
          unitName: { kind: "text", title: "Unit name, e.g. bar, slice (optional)", default: args.unitName ?? undefined },
        };
        const answer = await askForm(server, extra, "New ingredient — values per 100 g from the label", fields);
        if (answer.status === "declined") return { content: [{ type: "text", text: "The user cancelled. No ingredient was created." }] };
        if (answer.status === "unsupported") {
          return {
            isError: true,
            content: [{ type: "text", text: `Error (missing_fields): Missing ${missing.join(", ")}. Ask the user for the values per 100 g from the product label and call create_ingredient again.` }],
          };
        }
        input = { ...input, ...answer.values };
      }
      const created = serviceFor(extra).createIngredient(input as NewIngredientInput);
      return {
        content: [{ type: "text", text: `Created ${displayName(created)} [ingredientId: ${created.id}] · per 100 g: ${created.kcal100g} kcal, P ${created.protein100g} g, C ${created.carbs100g} g, F ${created.fat100g} g.` }],
        structuredContent: { ingredient: created },
      };
    } catch (e) {
      return errorResult(e);
    }
  });

  // ---------- save_recipe ----------
  server.registerTool("save_recipe", {
    title: "Save recipe",
    description:
      "Save a recipe. Either (a) pass `recipe` to create a new one, or (b) pass `recipeId` plus the preview adjustment and mode: " +
      "'overwrite' updates the saved recipe, 'copy' creates a new recipe (new ID, editable title) and leaves the original untouched.",
    inputSchema: {
      recipeId: z.string().optional(),
      mode: z.enum(["overwrite", "copy"]).optional(),
      title: z.string().min(1).max(140).optional().describe("New title (for copies: the copy's title)."),
      photoUrl: z.string().max(2000).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      category: z.enum(RECIPE_CATEGORIES).optional(),
      steps: z.array(z.string().min(1).max(2000)).max(60).optional()
        .describe("Replace the steps (with recipeId). Reference items as {item:<itemId>} using itemIds from open_recipe."),
      ...adjustmentShape,
      recipe: newRecipeSchema.optional().describe("A brand-new recipe to create. Do not combine with recipeId."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    _meta: uiMeta(),
  }, async (args, extra) => {
    try {
      const service = serviceFor(extra);
      if (args.recipe && args.recipeId) {
        throw new RecipeInputError("ambiguous_save", "Pass either recipe (to create) or recipeId (to save a preview), not both.");
      }
      if (args.recipe) {
        const created = service.createRecipe(args.recipe);
        return notebookResult(service, created.id, {}, "Created and saved", { saved: { mode: "create", recipeId: created.id } });
      }
      if (!args.recipeId) throw new RecipeInputError("missing_recipe", "Pass recipeId (to save a preview) or recipe (to create a new one).");
      const adjustment = adjustmentFrom(args);
      const preview = service.preview(args.recipeId, adjustment);
      let mode = args.mode;
      let title = args.title;
      if (!mode) {
        const answer = await askForm(server, extra, `Save "${preview.title}"`, {
          mode: {
            kind: "choice", title: "How do you want to save it?", required: true, default: "overwrite",
            options: [
              { const: "overwrite", title: "Overwrite the saved recipe" },
              { const: "copy", title: "Save as a new copy" },
            ],
          },
          title: { kind: "text", title: "Title for the copy", default: defaultCopyTitle(preview) },
        });
        if (answer.status === "declined") return { content: [{ type: "text", text: "Not saved: the user cancelled." }] };
        if (answer.status === "unsupported") {
          throw new RecipeInputError("missing_mode", 'mode is required: ask the user whether to "overwrite" the saved recipe or save a "copy".');
        }
        mode = answer.values.mode as "overwrite" | "copy";
        if (mode === "copy" && typeof answer.values.title === "string" && answer.values.title.trim()) title = answer.values.title;
      }
      if (mode === "copy" && title === undefined) title = defaultCopyTitle(preview);
      const { recipe, originalId } = service.save(args.recipeId, {
        mode,
        adjustment,
        title,
        photoUrl: args.photoUrl,
        notes: args.notes,
        category: args.category,
        steps: args.steps,
      });
      const heading = mode === "copy" ? `Saved as a new copy (original ${originalId} unchanged)` : "Saved (overwrote the recipe)";
      return notebookResult(service, recipe.id, {}, heading, { saved: { mode, recipeId: recipe.id, originalId } });
    } catch (e) {
      return errorResult(e);
    }
  });

  addSecuritySchemes(server);
  return server;
}

/**
 * The Apps SDK reads `securitySchemes` from each tool definition in tools/list.
 * SDK v1's McpServer does not emit unknown tool fields, so we decorate its
 * tools/list result. Every request is still authenticated at the HTTP layer.
 */
function addSecuritySchemes(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<{ tools: Record<string, unknown>[] }>> })._requestHandlers;
  const original = handlers?.get("tools/list");
  if (!original) return;
  handlers.set("tools/list", async (req, extra) => {
    const result = await original(req, extra);
    return { ...result, tools: result.tools.map((t) => ({ ...t, securitySchemes: AUTH })) };
  });
}
