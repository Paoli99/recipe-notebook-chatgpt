// Form elicitation with graceful degradation:
//  1. OpenAI extended forms (`openai/elicitation/create`) when the client
//     advertises `extensions["openai/elicitation"].form` — option descriptions
//     and image thumbnails.
//  2. Standard MCP form elicitation (`elicitation/create`) when the client
//     advertises `elicitation` — titled options, no thumbnails.
//  3. Otherwise "unsupported": the tool answers with plain data instead.
//
// Requests are sent with `extra.sendRequest` so they travel on the stream of
// the tool call that needs them.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ElicitResultSchema, type ServerNotification, type ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { OpenAIFormResultSchema, OpenAIFormSchema, createOpenAIFormContentSchema } from "@openai/mcp-extensions/server";

export type FormField =
  | { kind: "choice"; title: string; required?: boolean; default?: string; options: { const: string; title: string; description?: string; thumbnail?: string }[] }
  | { kind: "number"; title: string; required?: boolean; min?: number; max?: number; default?: number }
  | { kind: "text"; title: string; required?: boolean; default?: string };

export type FormAnswer =
  | { status: "accepted"; values: Record<string, string | number | boolean | undefined> }
  | { status: "declined" }
  | { status: "unsupported" };

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

export type FormSupport = "openai" | "standard" | "none";

export function formSupport(server: McpServer): FormSupport {
  const caps = server.server.getClientCapabilities() as Record<string, any> | undefined;
  if (caps?.extensions?.["openai/elicitation"]?.form) return "openai";
  if (caps?.elicitation) return "standard";
  return "none";
}

function clean<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

function buildSchema(fields: Record<string, FormField>, openai: boolean) {
  const properties: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(fields)) {
    if (f.kind === "choice") {
      properties[name] = clean({
        type: "string",
        title: f.title,
        default: f.default,
        oneOf: f.options.map((o) =>
          openai
            ? clean({ const: o.const, title: o.title, description: o.description, "x-openai-thumbnail": o.thumbnail ? { src: o.thumbnail } : undefined })
            : { const: o.const, title: o.description ? `${o.title} — ${o.description}` : o.title },
        ),
      });
    } else if (f.kind === "number") {
      properties[name] = clean({ type: "number", title: f.title, minimum: f.min, maximum: f.max, default: f.default });
    } else {
      properties[name] = clean({ type: "string", title: f.title, default: f.default });
    }
  }
  const required = Object.entries(fields).filter(([, f]) => f.required).map(([n]) => n);
  return { type: "object" as const, properties, required };
}

export async function askForm(server: McpServer, extra: Extra, message: string, fields: Record<string, FormField>): Promise<FormAnswer> {
  const support = formSupport(server);
  if (support === "none") return { status: "unsupported" };
  try {
    if (support === "openai") {
      const requestedSchema = OpenAIFormSchema.parse(buildSchema(fields, true));
      const result = await extra.sendRequest(
        // Custom OpenAI method: not part of the core ServerRequest union.
        { method: "openai/elicitation/create", params: { mode: "form", message, requestedSchema } } as unknown as ServerRequest,
        OpenAIFormResultSchema,
      );
      if (result.action !== "accept") return { status: "declined" };
      const values = createOpenAIFormContentSchema(requestedSchema).parse(result.content) as Record<string, string | number | boolean>;
      return { status: "accepted", values };
    }
    const result = await extra.sendRequest(
      { method: "elicitation/create", params: { mode: "form", message, requestedSchema: buildSchema(fields, false) } } as ServerRequest,
      ElicitResultSchema,
    );
    if (result.action !== "accept") return { status: "declined" };
    return { status: "accepted", values: (result.content ?? {}) as Record<string, string | number | boolean> };
  } catch (error) {
    console.error(`[recipe-notebook] form request failed, falling back: ${(error as Error).message}`);
    return { status: "unsupported" };
  }
}
