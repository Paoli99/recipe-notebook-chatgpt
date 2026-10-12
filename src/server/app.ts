import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import cors from "cors";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RecipeAuthProvider, SCOPE, loginRoutes } from "./auth.js";
import { buildMcpServer } from "./mcp.js";
import { RecipeService } from "./recipes.js";

export interface AppConfig {
  db: DatabaseSync;
  /** Public origin of this server, e.g. https://abc.ngrok.app (no trailing slash). */
  publicUrl: string;
  photoDomains: string[];
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
}

export function createApp({ db, publicUrl, photoDomains }: AppConfig) {
  const base = new URL(publicUrl);
  const mcpUrl = new URL("/mcp", base);
  const provider = new RecipeAuthProvider(db, mcpUrl.href);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(mcpUrl);
  const sessions = new Map<string, Session>();

  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // OAuth 2.1 authorization server + protected resource metadata (RFC 8414 / RFC 9728).
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: base,
    resourceServerUrl: mcpUrl,
    scopesSupported: [SCOPE],
    resourceName: "Recipe Notebook",
  }));
  // Some clients look for the metadata at the root path as well.
  app.get("/.well-known/oauth-protected-resource", cors(), (_req, res) => {
    res.json({
      resource: mcpUrl.href,
      authorization_servers: [base.href],
      scopes_supported: [SCOPE],
      resource_name: "Recipe Notebook",
    });
  });

  const login = loginRoutes(db, provider, (userId) => new RecipeService(db, userId).ensureDemoRecipe());
  app.get("/login", login.get);
  app.post("/login", express.urlencoded({ extended: false }), login.post);

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "recipe-notebook", mcp: mcpUrl.href, sessions: sessions.size });
  });

  const mcpCors = cors({
    origin: true,
    exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate", "Mcp-Protocol-Version"],
    allowedHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
  });
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], resourceMetadataUrl, expectedResource: mcpUrl });

  const handle = async (req: Request, res: Response) => {
    const userId = req.auth?.extra?.userId as string;
    const sessionId = req.header("mcp-session-id");
    let session = sessionId ? sessions.get(sessionId) : undefined;

    if (sessionId && !session) {
      res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
      return;
    }
    // A session belongs to the user who created it.
    if (session && session.userId !== userId) {
      res.status(403).json({ jsonrpc: "2.0", error: { code: -32003, message: "Session belongs to another user" }, id: null });
      return;
    }
    if (!session) {
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "Send an initialize request first" }, id: null });
        return;
      }
      new RecipeService(db, userId).ensureDemoRecipe();
      const server = buildMcpServer({ db, photoDomains });
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, userId });
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      session = { transport, server, userId };
    }
    await session.transport.handleRequest(req, res, req.body);
  };

  app.options("/mcp", mcpCors);
  app.all("/mcp", mcpCors, auth, express.json({ limit: "1mb" }), (req, res) => {
    handle(req, res).catch((error) => {
      console.error("[recipe-notebook] request failed", error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    });
  });

  return {
    app,
    provider,
    async close() {
      for (const s of sessions.values()) await s.transport.close().catch(() => {});
      sessions.clear();
    },
  };
}
