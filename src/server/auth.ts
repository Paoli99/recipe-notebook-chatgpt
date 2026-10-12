// Built-in OAuth 2.1 authorization server (authorization code + PKCE S256,
// dynamic client registration, refresh-token rotation). The HTTP endpoints and
// protocol validation come from the MCP SDK's mcpAuthRouter; this file only
// provides storage, the sign-in page and token issuance.
import type { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { InvalidGrantError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { newId } from "./recipes.js";

export const SCOPE = "recipes";
const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;
const PENDING_TTL_S = 15 * 60;

const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
const token = () => randomBytes(32).toString("base64url");
const nowS = () => Math.floor(Date.now() / 1000);

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [, salt, hash] = stored.split("$");
  const expected = Buffer.from(hash, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length);
  return timingSafeEqual(actual, expected);
}

export interface UserRecord {
  id: string;
  email: string;
}

export function createUser(db: DatabaseSync, email: string, password: string): UserRecord {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("Enter a valid email address.");
  if (password.length < 8) throw new Error("Use a password with at least 8 characters.");
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(normalized)) throw new Error("An account with that email already exists. Sign in instead.");
  const id = newId("usr");
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)")
    .run(id, normalized, hashPassword(password), new Date().toISOString());
  return { id, email: normalized };
}

export function authenticateUser(db: DatabaseSync, email: string, password: string): UserRecord | null {
  const row = db.prepare("SELECT id, email, password_hash FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as { id: string; email: string; password_hash: string } | undefined;
  if (!row || !verifyPassword(password, row.password_hash)) return null;
  return { id: row.id, email: row.email };
}

class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: DatabaseSync) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db.prepare("SELECT data FROM oauth_clients WHERE client_id = ?").get(clientId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  registerClient(client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: newId("client"),
      client_id_issued_at: nowS(),
    };
    this.db.prepare("INSERT INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)")
      .run(full.client_id, JSON.stringify(full), new Date().toISOString());
    return full;
  }
}

interface PendingAuthorization {
  clientId: string;
  clientName: string | null;
  redirectUri: string;
  state?: string;
  scopes: string[];
  codeChallenge: string;
  resource?: string;
}

export class RecipeAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SqliteClientsStore;

  constructor(private readonly db: DatabaseSync, private readonly defaultResource: string) {
    this.clientsStore = new SqliteClientsStore(db);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const id = token();
    const pending: PendingAuthorization = {
      clientId: client.client_id,
      clientName: client.client_name ?? null,
      redirectUri: params.redirectUri,
      state: params.state,
      scopes: params.scopes?.length ? params.scopes : [SCOPE],
      codeChallenge: params.codeChallenge,
      resource: params.resource?.href,
    };
    this.db.prepare("DELETE FROM oauth_pending WHERE expires_at < ?").run(nowS());
    this.db.prepare("INSERT INTO oauth_pending (id, client_id, data, expires_at) VALUES (?, ?, ?, ?)")
      .run(id, client.client_id, JSON.stringify(pending), nowS() + PENDING_TTL_S);
    res.redirect(302, `/login?request=${encodeURIComponent(id)}`);
  }

  getPending(id: string): PendingAuthorization | undefined {
    const row = this.db.prepare("SELECT data FROM oauth_pending WHERE id = ? AND expires_at >= ?").get(id, nowS()) as { data: string } | undefined;
    return row ? JSON.parse(row.data) : undefined;
  }

  /** Completes a pending authorization for a signed-in user; returns the redirect URL. */
  completeAuthorization(pendingId: string, userId: string): string {
    const pending = this.getPending(pendingId);
    if (!pending) throw new Error("This sign-in request expired. Start the connection again.");
    this.db.prepare("DELETE FROM oauth_pending WHERE id = ?").run(pendingId);
    const code = token();
    this.db.prepare(`INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, code_challenge, scopes, resource, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(sha256(code), pending.clientId, userId, pending.redirectUri, pending.codeChallenge,
        pending.scopes.join(" "), pending.resource ?? null, nowS() + CODE_TTL_S);
    const url = new URL(pending.redirectUri);
    url.searchParams.set("code", code);
    if (pending.state !== undefined) url.searchParams.set("state", pending.state);
    return url.toString();
  }

  /** Redirect URL that tells the client the user declined. */
  denyAuthorization(pendingId: string): string {
    const pending = this.getPending(pendingId);
    if (!pending) throw new Error("This sign-in request expired.");
    this.db.prepare("DELETE FROM oauth_pending WHERE id = ?").run(pendingId);
    const url = new URL(pending.redirectUri);
    url.searchParams.set("error", "access_denied");
    if (pending.state !== undefined) url.searchParams.set("state", pending.state);
    return url.toString();
  }

  private findCode(client: OAuthClientInformationFull, code: string) {
    const row = this.db.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").get(sha256(code)) as
      | { client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < nowS()) {
      throw new InvalidGrantError("Invalid or expired authorization code");
    }
    return row;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.findCode(client, authorizationCode).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.findCode(client, authorizationCode);
    this.db.prepare("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(authorizationCode));
    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError("redirect_uri mismatch");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource mismatch");
    return this.issueTokens(client.client_id, row.user_id, row.scopes.split(" "), row.resource ?? resource?.href ?? this.defaultResource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(sha256(refreshToken)) as
      | { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number }
      | undefined;
    if (!row || row.client_id !== client.client_id || row.expires_at < nowS()) throw new InvalidGrantError("Invalid refresh token");
    if (resource && row.resource && resource.href !== row.resource) throw new InvalidGrantError("resource mismatch");
    const granted = row.scopes.split(" ");
    const requested = scopes?.length ? scopes : granted;
    if (requested.some((s) => !granted.includes(s))) throw new InvalidGrantError("Requested scope was not granted");
    // Rotate: the old refresh token stops working.
    this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ?").run(sha256(refreshToken));
    return this.issueTokens(client.client_id, row.user_id, requested, row.resource ?? this.defaultResource);
  }

  issueTokens(clientId: string, userId: string, scopes: string[], resource: string): OAuthTokens {
    const access = token();
    const refresh = token();
    const insert = this.db.prepare(`INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scopes, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    insert.run(sha256(access), "access", clientId, userId, scopes.join(" "), resource, nowS() + ACCESS_TTL_S);
    insert.run(sha256(refresh), "refresh", clientId, userId, scopes.join(" "), resource, nowS() + REFRESH_TTL_S);
    return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope: scopes.join(" ") };
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    const row = this.db.prepare(`SELECT t.client_id, t.user_id, t.scopes, t.resource, t.expires_at, u.email
      FROM oauth_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.kind = 'access'`)
      .get(sha256(accessToken)) as
      | { client_id: string; user_id: string; scopes: string; resource: string | null; expires_at: number; email: string }
      | undefined;
    if (!row || row.expires_at < nowS()) throw new InvalidTokenError("Invalid or expired access token");
    return {
      token: accessToken,
      clientId: row.client_id,
      scopes: row.scopes.split(" "),
      expiresAt: row.expires_at,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id, email: row.email },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.db.prepare("DELETE FROM oauth_tokens WHERE token_hash = ? AND client_id = ?").run(sha256(request.token), client.client_id);
  }
}

// ---------- Sign-in page ----------

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function loginPage(requestId: string, clientName: string | null, error?: string, email = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Recipe Notebook · Sign in</title>
<style>
:root{--paper:#fbf6ea;--ink:#2f2a24;--muted:#7a6f62;--sage:#7d9471;--terra:#c0673f;--line:#e6dcc7}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--paper);
background-image:radial-gradient(#d9ccb3 1px,transparent 1px);background-size:18px 18px;color:var(--ink);font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}
main{width:100%;max-width:380px;background:#fffdf7;border:1px solid var(--line);border-radius:6px;padding:28px;box-shadow:0 10px 30px rgba(60,40,10,.08)}
h1{font-family:"Iowan Old Style",Georgia,serif;font-weight:600;margin:0 0 4px;font-size:28px}
p{margin:0 0 18px;color:var(--muted)}label{display:block;font-size:14px;margin:12px 0 4px}
input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:4px;font:inherit;background:#fff}
.row{display:flex;gap:8px;margin-top:18px}button{flex:1;padding:10px;border-radius:4px;border:1px solid var(--sage);font:inherit;cursor:pointer}
.primary{background:var(--sage);color:#fff}.secondary{background:#fff;color:var(--ink)}
.err{background:#fbe9e2;color:#8a3b1c;border-left:3px solid var(--terra);padding:8px 10px;margin-bottom:12px;font-size:14px}
.deny{margin-top:14px;text-align:center}.deny button{background:none;border:0;color:var(--muted);text-decoration:underline;flex:none}
</style></head><body><main>
<h1>Recipe Notebook</h1>
<p>${clientName ? `<b>${esc(clientName)}</b> wants` : "An app wants"} to read and edit your recipes.</p>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ""}
<form method="post" action="/login">
<input type="hidden" name="request" value="${esc(requestId)}">
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required value="${esc(email)}">
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" minlength="8" required>
<div class="row"><button class="primary" name="action" value="signin">Sign in</button><button class="secondary" name="action" value="signup">Create account</button></div>
</form>
<form class="deny" method="post" action="/login"><input type="hidden" name="request" value="${esc(requestId)}"><button name="action" value="deny">Cancel</button></form>
</main></body></html>`;
}

export function loginRoutes(db: DatabaseSync, provider: RecipeAuthProvider, onSignedIn: (userId: string) => void) {
  return {
    get(req: Request, res: Response) {
      const id = String(req.query.request ?? "");
      const pending = provider.getPending(id);
      if (!pending) {
        res.status(400).type("html").send("<p>This sign-in link expired. Start the connection again from your MCP client.</p>");
        return;
      }
      res.type("html").send(loginPage(id, pending.clientName));
    },
    post(req: Request, res: Response) {
      const body = req.body as Record<string, string | undefined>;
      const id = String(body.request ?? "");
      const pending = provider.getPending(id);
      if (!pending) {
        res.status(400).type("html").send("<p>This sign-in link expired. Start the connection again from your MCP client.</p>");
        return;
      }
      if (body.action === "deny") {
        res.redirect(302, provider.denyAuthorization(id));
        return;
      }
      const email = String(body.email ?? "");
      const password = String(body.password ?? "");
      try {
        let user: UserRecord | null;
        if (body.action === "signup") {
          user = createUser(db, email, password);
        } else {
          user = authenticateUser(db, email, password);
          if (!user) throw new Error("Wrong email or password.");
        }
        onSignedIn(user.id);
        res.redirect(302, provider.completeAuthorization(id, user.id));
      } catch (error) {
        res.status(400).type("html").send(loginPage(id, pending.clientName, (error as Error).message, email));
      }
    },
  };
}
