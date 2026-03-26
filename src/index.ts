#!/usr/bin/env node
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { parseArgs } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { ClawallexClient } from "./client.js";
import { resolveClientId } from "./client-id.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerWalletTools } from "./tools/wallet.js";
import { registerCardTools } from "./tools/cards.js";
import { registerTransactionTools } from "./tools/transactions.js";
import { registerRefillTools } from "./tools/refill.js";
import { registerPaymentTools } from "./tools/payment.js";

function parseCliArgs(): {
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
  transport: "stdio" | "sse" | "http";
  port: number;
  clientIdArg?: string;
} {
  const { values } = parseArgs({
    options: {
      "api-key": { type: "string" },
      "api-secret": { type: "string" },
      "base-url": { type: "string" },
      "transport": { type: "string" },
      "port": { type: "string" },
      "client-id": { type: "string" },
    },
    strict: false,
  });

  // CLI args take precedence, fall back to environment variables
  const apiKey = values["api-key"] ?? process.env.CLAWALLEX_API_KEY;
  const apiSecret = values["api-secret"] ?? process.env.CLAWALLEX_API_SECRET;
  const baseUrl = values["base-url"] ?? process.env.CLAWALLEX_BASE_URL;

  const missing: string[] = [];
  if (!apiKey) missing.push("--api-key or CLAWALLEX_API_KEY");
  if (!apiSecret) missing.push("--api-secret or CLAWALLEX_API_SECRET");

  if (missing.length > 0) {
    console.error(`Error: missing required arguments: ${missing.join(", ")}`);
    console.error(
      "Usage: clawallex-mcp --api-key <key> --api-secret <secret> [--base-url <url>] [--client-id <uuid>] [--transport stdio|sse|http] [--port 18080]",
    );
    console.error(
      "  Or set environment variables: CLAWALLEX_API_KEY, CLAWALLEX_API_SECRET, CLAWALLEX_BASE_URL",
    );
    process.exit(1);
  }

  const transportVal = (values["transport"] as string) ?? "stdio";
  if (transportVal !== "stdio" && transportVal !== "sse" && transportVal !== "http") {
    console.error(`Error: --transport must be "stdio", "sse" or "http"`);
    process.exit(1);
  }

  const port = parseInt((values["port"] as string) ?? "18080", 10);
  if (isNaN(port) || port <= 0) {
    console.error("Error: --port must be a valid positive integer");
    process.exit(1);
  }

  return {
    apiKey: apiKey as string,
    apiSecret: apiSecret as string,
    baseUrl: (baseUrl as string) ?? "https://api.clawallex.com",
    transport: transportVal,
    port,
    clientIdArg: (values["client-id"] as string | undefined) ?? process.env.CLAWALLEX_CLIENT_ID,
  };
}

function createMcpServer(client: ClawallexClient): McpServer {
  const server = new McpServer({ name: "clawallex", version: "0.1.0" });
  registerAuthTools(server, client);
  registerWalletTools(server, client);
  registerCardTools(server, client);
  registerTransactionTools(server, client);
  registerRefillTools(server, client);
  registerPaymentTools(server, client);
  return server;
}

async function main(): Promise<void> {
  const { apiKey, apiSecret, baseUrl, transport, port, clientIdArg } = parseCliArgs();
  const clientId = resolveClientId(baseUrl, clientIdArg);
  const client = new ClawallexClient(apiKey, apiSecret, baseUrl, clientId);

  if (transport === "sse") {
    const sessions = new Map<string, SSEServerTransport>();
    const server = createMcpServer(client);

    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && req.url === "/sse") {
        const sseTransport = new SSEServerTransport("/messages", res);
        sessions.set(sseTransport.sessionId, sseTransport);
        sseTransport.onclose = () => sessions.delete(sseTransport.sessionId);
        await server.connect(sseTransport);
      } else if (req.method === "POST" && req.url?.startsWith("/messages")) {
        const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId") ?? "";
        const sseTransport = sessions.get(sessionId);
        if (!sseTransport) {
          res.writeHead(404).end("Session not found");
          return;
        }
        await sseTransport.handlePostMessage(req, res);
      } else {
        res.writeHead(404).end("Not found");
      }
    });

    httpServer.listen(port, () => {
      console.error(`Clawallex MCP server (SSE) listening on http://localhost:${port}/sse`);
    });
  } else if (transport === "http") {
    const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === "/mcp") {
        const server = createMcpServer(client);
        const httpTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await server.connect(httpTransport);
        await httpTransport.handleRequest(req, res);
      } else {
        res.writeHead(404).end("Not found");
      }
    });

    httpServer.listen(port, () => {
      console.error(`Clawallex MCP server (Streamable HTTP) listening on http://localhost:${port}/mcp`);
    });
  } else {
    const server = createMcpServer(client);
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
