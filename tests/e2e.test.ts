// End-to-end: real HTTP server, OAuth 2.1 (DCR + PKCE) sign-up, MCP client over Streamable HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/server/app.js";

let http: Server;
let base: string;
let closeApp: () => Promise<void>;

before(async () => {
  const db = openDatabase(":memory:");
  // Bind first so the public URL (issuer + resource) matches the real port.
  const probe = await new Promise<Server>((resolve) => {
    const s = (createApp({ db, publicUrl: "http://localhost:1", photoDomains: [] }).app).listen(0, "127.0.0.1", () => resolve(s));
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise((r) => probe.close(r));
  base = `http://localhost:${port}`;
  const created = createApp({ db, publicUrl: base, photoDomains: [] });
  closeApp = created.close;
  http = await new Promise<Server>((resolve) => {
    const s = created.app.listen(port, "127.0.0.1", () => resolve(s));
  });
});

after(async () => {
  await closeApp();
  await new Promise((r) => http.close(r));
});

async function signUp(email: string): Promise<string> {
  const redirectUri = "http://localhost:9999/callback";
  const reg = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
  });
  assert.equal(reg.status, 201);
  const { client_id } = await reg.json() as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const auth = new URL(`${base}/authorize`);
  auth.search = new URLSearchParams({ response_type: "code", client_id, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "recipes", resource: `${base}/mcp` }).toString();
  const r1 = await fetch(auth, { redirect: "manual" });
  assert.equal(r1.status, 302);
  const loginUrl = new URL(r1.headers.get("location")!, base);
  const requestId = loginUrl.searchParams.get("request")!;
  const page = await fetch(loginUrl);
  assert.match(await page.text(), /Test client<\/b> wants/);
  const r2 = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ request: requestId, email, password: "correct horse battery", action: "signup" }),
  });
  assert.equal(r2.status, 302);
  const callback = new URL(r2.headers.get("location")!);
  assert.equal(callback.searchParams.get("state"), "xyz");
  const tokenRes = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: callback.searchParams.get("code")!, code_verifier: verifier, client_id, redirect_uri: redirectUri, resource: `${base}/mcp` }),
  });
  assert.equal(tokenRes.status, 200);
  const tokens = await tokenRes.json() as { access_token: string };
  return tokens.access_token;
}

async function connect(token: string, opts: { elicitation?: (params: any) => any } = {}) {
  const client = new Client({ name: "e2e", version: "1.0.0" }, { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} });
  if (opts.elicitation) client.setRequestHandler(ElicitRequestSchema, async (req) => opts.elicitation!(req.params));
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  await client.connect(transport);
  return client;
}

const text = (r: unknown) => ((r as CallToolResult).content[0] as { text: string }).text;
const sc = (r: unknown) => (r as CallToolResult).structuredContent as any;

test("unauthenticated MCP requests get 401 with resource metadata", async () => {
  const res = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.status, 401);
  assert.match(res.headers.get("www-authenticate") ?? "", /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as { resource: string; authorization_servers: string[] };
  assert.equal(meta.resource, `${base}/mcp`);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json() as { code_challenge_methods_supported: string[] };
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
});

test("full flow over MCP: tools, panel resource, preview, save, copy, isolation", async () => {
  const alice = await connect(await signUp("alice@example.com"));
  const bob = await connect(await signUp("bob@example.com"));

  const { tools } = await alice.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["adjust_recipe", "create_ingredient", "list_recipes", "open_recipe", "save_recipe", "search_ingredients", "suggest_substitutes"]);
  const open = tools.find((t) => t.name === "open_recipe")!;
  assert.equal((open._meta as any).ui.resourceUri, "ui://recipe-notebook/notebook-v1.html");
  assert.deepEqual((open._meta as any)["openai/ui"].entrypoints, [{ type: "thread" }]);
  // The SDK client strips unknown tool fields, so read tools/list raw to see securitySchemes.
  const raw = await alice.request({ method: "tools/list" }, z.object({ tools: z.array(z.looseObject({ name: z.string() })) }));
  for (const t of raw.tools) assert.deepEqual(t.securitySchemes, [{ type: "oauth2", scopes: ["recipes"] }]);

  const resource = await alice.readResource({ uri: "ui://recipe-notebook/notebook-v1.html" });
  assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");

  const list = await alice.callTool({ name: "list_recipes", arguments: {} });
  const demoId = sc(list).recipes[0].id as string;

  // Thread entrypoint calls open_recipe with {} → library view.
  assert.equal(sc(await alice.callTool({ name: "open_recipe", arguments: {} })).view, "library");

  const scaled = await alice.callTool({ name: "open_recipe", arguments: { recipeId: demoId, mainGrams: 100 } });
  assert.equal(sc(scaled).preview.factor, 0.125);
  assert.match(text(scaled), /unsaved preview/);

  const ambiguous = await alice.callTool({ name: "adjust_recipe", arguments: { recipeId: demoId, mainGrams: 100, servings: 2 } });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /either mainGrams or servings/);

  const invalid = await alice.callTool({ name: "adjust_recipe", arguments: { recipeId: demoId, mainGrams: -5 } });
  assert.equal(invalid.isError, true);

  // Substitutes as a plain list (no form support on this client).
  const recipe = sc(scaled).recipe;
  const yogurt = recipe.items.find((i: any) => i.ingredient.id === "greek-yogurt-whole");
  const subs = await alice.callTool({ name: "suggest_substitutes", arguments: { recipeId: demoId, itemId: yogurt.id } });
  assert.ok(sc(subs).suggestions.length > 0);
  assert.match(text(subs), /differences are for 150 g/);

  const adjusted = await alice.callTool({ name: "adjust_recipe", arguments: { recipeId: demoId, servings: 2, substitutions: [{ itemId: yogurt.id, ingredientId: "sour-cream" }] } });
  assert.match(text(adjusted), /75 g Sour cream/);
  // still not saved
  assert.equal(sc(await alice.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).preview.servings, 4);

  // Save without mode on a client without forms → clear error.
  const noMode = await alice.callTool({ name: "save_recipe", arguments: { recipeId: demoId, servings: 2 } });
  assert.equal(noMode.isError, true);
  assert.match(text(noMode), /mode is required/);

  const copy = await alice.callTool({ name: "save_recipe", arguments: { recipeId: demoId, mode: "copy", servings: 2, substitutions: [{ itemId: yogurt.id, ingredientId: "sour-cream" }] } });
  const copyId = sc(copy).saved.recipeId;
  assert.notEqual(copyId, demoId);
  assert.match(sc(copy).recipe.title, /— 2 servings$/);
  assert.equal(sc(await alice.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).preview.servings, 4);

  await alice.callTool({ name: "save_recipe", arguments: { recipeId: demoId, mode: "overwrite", mainGrams: 400 } });
  const reopened = sc(await alice.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).preview;
  assert.equal(reopened.servings, 2);
  assert.equal(reopened.isModified, false);

  // Bob cannot see or touch Alice's recipes.
  const stolen = await bob.callTool({ name: "open_recipe", arguments: { recipeId: demoId } });
  assert.equal(stolen.isError, true);
  assert.match(text(stolen), /not found/);
  const overwrite = await bob.callTool({ name: "save_recipe", arguments: { recipeId: demoId, mode: "overwrite", servings: 1 } });
  assert.equal(overwrite.isError, true);
  assert.equal(sc(await alice.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).preview.servings, 2);

  // Custom ingredient privacy over MCP.
  const created = await alice.callTool({ name: "create_ingredient", arguments: { name: "Oat milk", brand: "Oatly", category: "drink", kcal100g: 59, protein100g: 1, carbs100g: 6.6, fat100g: 3 } });
  assert.equal(created.isError, undefined);
  assert.equal(sc(await bob.callTool({ name: "search_ingredients", arguments: { query: "oatly" } })).ingredients.length, 0);
  assert.equal(sc(await alice.callTool({ name: "search_ingredients", arguments: { query: "oatly" } })).ingredients.length, 1);

  const missing = await alice.callTool({ name: "create_ingredient", arguments: { name: "Mystery bar" } });
  assert.equal(missing.isError, true);
  assert.match(text(missing), /Missing category, kcal100g/);

  await alice.close();
  await bob.close();
});

test("forms: standard MCP elicitation picks a substitute and the save mode", async () => {
  const answers: Record<string, unknown>[] = [];
  const client = await connect(await signUp("carol@example.com"), {
    elicitation: (params) => {
      const props = params.requestedSchema.properties;
      if (props.ingredientId) {
        const first = props.ingredientId.oneOf[0].const;
        answers.push({ kind: "substitute", options: props.ingredientId.oneOf.length });
        return { action: "accept", content: { ingredientId: first, grams: props.grams.default } };
      }
      answers.push({ kind: "save" });
      return { action: "accept", content: { mode: "copy", title: "Carol's copy" } };
    },
  });
  const demoId = sc(await client.callTool({ name: "list_recipes", arguments: {} })).recipes[0].id;
  const recipe = sc(await client.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).recipe;
  const chicken = recipe.items.find((i: any) => i.ingredient.id === "chicken-breast-raw");
  const picked = await client.callTool({ name: "suggest_substitutes", arguments: { recipeId: demoId, itemId: chicken.id, mainGrams: 400 } });
  assert.equal(picked.isError, undefined);
  const preview = sc(picked).preview;
  const main = preview.items.find((i: any) => i.id === chicken.id);
  assert.notEqual(main.ingredient.id, "chicken-breast-raw");
  assert.equal(main.grams, 400);
  assert.match(text(picked), /not saved/);

  const saved = await client.callTool({ name: "save_recipe", arguments: { recipeId: demoId, ...preview.adjustment } });
  assert.equal(sc(saved).recipe.title, "Carol's copy");
  assert.deepEqual(answers.map((a) => a.kind), ["substitute", "save"]);
  await client.close();
});

test("forms: OpenAI extended forms send thumbnails and macro-difference descriptions", async () => {
  const token = await signUp("dana@example.com");
  const client = new Client({ name: "chatgpt-like", version: "1.0.0" }, {
    capabilities: { elicitation: { form: {} }, extensions: { "openai/elicitation": { form: {} } } } as any,
  });
  let seen: any;
  client.setRequestHandler(z.object({ method: z.literal("openai/elicitation/create"), params: z.any() }) as any, async (req: any) => {
    seen = req.params;
    const field = req.params.requestedSchema.properties.ingredientId;
    return { action: "accept", content: { ingredientId: field.oneOf[1].const, grams: 120 } };
  });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const demoId = sc(await client.callTool({ name: "list_recipes", arguments: {} })).recipes[0].id;
  const recipe = sc(await client.callTool({ name: "open_recipe", arguments: { recipeId: demoId } })).recipe;
  const yogurt = recipe.items.find((i: any) => i.ingredient.id === "greek-yogurt-whole");
  const res = await client.callTool({ name: "suggest_substitutes", arguments: { recipeId: demoId, itemId: yogurt.id } });
  const option = seen.requestedSchema.properties.ingredientId.oneOf[0];
  assert.match(option["x-openai-thumbnail"].src, /^data:image\/svg\+xml;base64,/);
  assert.match(option.description, /kcal.*for 150 g/);
  const item = sc(res).preview.items.find((i: any) => i.id === yogurt.id);
  assert.equal(item.grams, 120);
  assert.notEqual(item.ingredient.id, "greek-yogurt-whole");
  await client.close();
});
