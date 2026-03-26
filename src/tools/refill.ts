import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient } from "../client.js";
import { toolError, toolOk } from "./utils.js";
import { x402Fields } from "./cards.js";

export function registerRefillTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "refill_card",
    [
      "Advanced: refill a stream card with full control over payment mode.",
      "Maps directly to POST /payment/cards/:card_id/refill.",
      "Refill mode follows the card's creation mode (cannot switch mid-life).",
      "",
      "Mode A: client_request_id as idempotency key.",
      "Mode B: no 402 challenge — caller signs the EIP-3009 authorization independently.",
      "  Step 1: call get_x402_payee_address to get payee_address for payment_requirements.payTo.",
      "  Step 2: sign EIP-3009 transferWithAuthorization using your own wallet/signing library.",
      "  Step 3: submit with x402_reference_id as idempotency key + payment_payload (signature + wallet address) + payment_requirements.",
      "",
      "Only cards created by this agent (same client_id) can be refilled.",
    ].join("\n"),
    {
      card_id: z.string().describe("Stream card ID to refill, e.g. 'c_123'"),
      amount: z.string().describe("Refill amount in USD, decimal string e.g. '30.0000'"),
      client_request_id: z
        .string()
        .max(64)
        .describe(
          "UUID idempotency key — REQUIRED for Mode A. Omitting on a Mode A card will cause the server to reject the request. Reuse the same UUID to retry safely without double-charging.",
        )
        .optional(),
      ...x402Fields,
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          amount: params.amount,
        };
        if (params.client_request_id !== undefined) body.client_request_id = params.client_request_id;
        if (params.x402_reference_id !== undefined) body.x402_reference_id = params.x402_reference_id;
        if (params.x402_version !== undefined) body.x402_version = params.x402_version;
        if (params.payment_payload !== undefined) body.payment_payload = params.payment_payload;
        if (params.payment_requirements !== undefined) body.payment_requirements = params.payment_requirements;
        if (params.payer_address !== undefined) body.payer_address = params.payer_address;

        const result = await client.post<unknown>(
          `/payment/cards/${params.card_id}/refill`,
          body,
        );
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
