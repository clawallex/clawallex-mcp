import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient } from "../client.js";
import { toolError, toolOk } from "./utils.js";
import { saveClientId } from "../client-id.js";

export function registerAuthTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "clawallex_setup",
    [
      "Check current Clawallex connection status and ensure agent identity is bound.",
      "Calls whoami to verify API Key, then bootstrap to bind client_id if not yet bound.",
      "Use this after starting the MCP server to confirm everything is ready for payment operations.",
      "",
      "Returns: user_id, api_key_id, bound_client_id, client_id_bound status.",
    ].join(" "),
    {},
    async () => {
      try {
        const whoami = await client.getAuth<Record<string, unknown>>("/auth/whoami");
        if (whoami.client_id_bound) {
          return toolOk({
            status: "ready",
            ...whoami,
            _hint: `Connected. API Key bound to client_id '${whoami.bound_client_id}'.`,
          });
        }
        // Not yet bound — auto-bootstrap
        const bootstrap = await client.postAuth<{ client_id: string; created: boolean }>("/auth/bootstrap", {});
        saveClientId(client.baseUrlValue, bootstrap.client_id);
        client.setClientId(bootstrap.client_id);
        return toolOk({
          status: "ready",
          ...whoami,
          bound_client_id: bootstrap.client_id,
          client_id_bound: true,
          _hint: `Connected and bound to client_id '${bootstrap.client_id}'.`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "whoami",
    [
      "Query the current API Key binding status — read-only, does NOT modify any state.",
      "Returns:",
      "• client_id_bound=true → this API Key is already bound to a specific client_id.",
      "• client_id_bound=false → this API Key is not yet bound; call bootstrap to bind.",
      "",
      "Example response (bound):",
      '  { "user_id": "u_123", "api_key_id": "ak_123", "status": 100, "bound_client_id": "ca_abc123", "client_id_bound": true }',
      "",
      "Example response (unbound):",
      '  { "user_id": "u_123", "api_key_id": "ak_123", "status": 100, "bound_client_id": "", "client_id_bound": false }',
    ].join(" "),
    {},
    async () => {
      try {
        const result = await client.getAuth<unknown>("/auth/whoami");
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "bootstrap",
    [
      "Bind a client_id to the current API Key, or let the server generate one.",
      "This is the recommended way to establish agent identity before making payment calls.",
      "Once bound, the client_id cannot be changed for this API Key.",
      "",
      "Behavior:",
      "• API Key not yet bound + no preferred_client_id → server generates a ca_ prefixed ID.",
      "• API Key not yet bound + preferred_client_id → binds the provided value.",
      "• API Key already bound + same value (or omitted) → idempotent, returns existing binding.",
      "• API Key already bound + different value → 409 conflict.",
      "",
      "On success, the returned client_id is automatically saved locally.",
      "",
      "Example: bootstrap() → { client_id: 'ca_abc123', created: true }",
      "Example: bootstrap({ preferred_client_id: 'my-agent-uuid' }) → { client_id: 'my-agent-uuid', created: true }",
    ].join(" "),
    {
      preferred_client_id: z.string()
        .describe("Optional: your preferred client_id value. If omitted, server generates one with ca_ prefix.")
        .optional(),
    },
    async ({ preferred_client_id }) => {
      try {
        const body: Record<string, unknown> = {};
        if (preferred_client_id) body.preferred_client_id = preferred_client_id;
        const result = await client.postAuth<{ client_id: string; created: boolean }>("/auth/bootstrap", body);
        saveClientId(client.baseUrlValue, result.client_id);
        client.setClientId(result.client_id);
        return toolOk({
          ...result,
          _hint: result.created
            ? `client_id '${result.client_id}' has been bound to this API Key and saved locally. All subsequent payment operations will use this identity.`
            : `Already bound to client_id '${result.client_id}'. No changes made.`,
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
