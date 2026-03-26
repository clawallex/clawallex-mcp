import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient } from "../client.js";
import { toolError, toolOk } from "./utils.js";

export function registerTransactionTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "list_transactions",
    [
      "List card transactions for this agent (scoped to the server's client_id).",
      "Transactions from other agents using the same API key are not visible.",
      "All filter parameters are optional — omit all to list recent transactions across all cards.",
    ].join(" "),
    {
      card_tx_id: z.string().describe("Filter by platform transaction ID (e.g. 'ctx_123')").optional(),
      issuer_tx_id: z.string().describe("Filter by issuer transaction ID").optional(),
      card_id: z.string().describe("Filter by card ID (e.g. 'c_123') to get transactions for one card").optional(),
      page: z.number().int().min(1).default(1).describe("Page number, starting from 1 (default 1)").optional(),
      page_size: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(20)
        .describe("Results per page, max 100 (default 20)")
        .optional(),
    },
    async (params) => {
      try {
        const query: Record<string, string | number> = {};
        if (params.card_tx_id !== undefined) query.card_tx_id = params.card_tx_id;
        if (params.issuer_tx_id !== undefined) query.issuer_tx_id = params.issuer_tx_id;
        if (params.card_id !== undefined) query.card_id = params.card_id;
        if (params.page !== undefined) query.page = params.page;
        if (params.page_size !== undefined) query.page_size = params.page_size;

        const result = await client.get<unknown>("/payment/transactions", query);
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
