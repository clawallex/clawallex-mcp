import { z } from "zod";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient, ClawallexApiError } from "../client.js";
import { toolError, toolOk, formatX402Quote } from "./utils.js";
import { x402Fields } from "./cards.js";

export function registerPaymentTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "clawallex_pay",
    [
      "Pay for a product or service using USDC.",
      "Creates a single-use flash virtual card (card_type=100), deducts from wallet balance, returns card details for checkout.",
      "",
      "Mode A (mode_code=100, default): wallet balance → flash card. Immediate settlement.",
      "Mode B (mode_code=200): for callers with self-custody wallets — signing is performed by the caller. x402 on-chain two-stage flow:",
      "  Stage 1 (Quote): POST with mode_code=200, chain_code, token_code.",
      "    The 402 response is EXPECTED — it is a quote, NOT an error. Returns:",
      "    card_order_id, client_request_id, x402_reference_id, payee_address, asset_address,",
      "    final_card_amount, issue_fee_amount, fx_fee_amount, fee_amount, payable_amount.",
      "  Agent signs: construct and sign an EIP-3009 transferWithAuthorization using your own wallet/signing library.",
      "    Stage 2 requires the resulting signature and your wallet address (authorization.from).",
      "    authorization fields: from=your wallet address, to=payee_address, value=maxAmountRequired,",
      "    validAfter/validBefore=unix seconds validity window, nonce=random 32-byte hex (unique per auth).",
      "  Stage 2 (Settle): POST again with SAME client_request_id + signed x402 data:",
      "    - payment_requirements.payTo MUST equal payee_address from Stage 1",
      "    - payment_requirements.asset MUST equal asset_address from Stage 1",
      "    - payment_requirements.maxAmountRequired MUST equal payable_amount × 10^decimals (USDC = 6 decimals, e.g. '207.59' → '207590000')",
      "    - payment_requirements.extra.referenceId MUST equal x402_reference_id from Stage 1",
      "    - extra.card_amount MUST equal amount, extra.paid_amount MUST equal amount + fee_amount",
      "    - If settle is rejected, order stays pending_payment — fix params and retry with same client_request_id.",
      "",
      "Fee structure: fee_amount = issue_fee_amount + fx_fee_amount. total_amount = amount + fee_amount.",
      "",
      "Example (Mode A): clawallex_pay({ amount: 50, description: 'OpenAI API credits' })",
    ].join("\n"),
    {
      amount: z.number().describe("Card face amount in USD"),
      description: z.string().describe("What this payment is for"),
      mode_code: z.number().int().describe("100=wallet (default), 200=x402 on-chain").optional(),
      tx_limit: z.string().describe("Per-transaction limit in USD (optional, default 100.0000)").optional(),
      allowed_mcc: z.string().describe("MCC whitelist, comma-separated (optional, e.g. '5734,5815')").optional(),
      blocked_mcc: z.string().describe("MCC blacklist, comma-separated (optional, e.g. '7995')").optional(),
      client_request_id: z.string().max(64).describe("UUID idempotency key (<=64 chars). Mode B Stage 2: MUST reuse from Stage 1.").optional(),
      chain_code: z.string().describe("Chain code for Mode B Stage 1 (e.g. 'ETH')").optional(),
      token_code: z.string().describe("Token code for Mode B Stage 1 (e.g. 'USDC')").optional(),
      extra: z.record(z.unknown()).describe("Mode B Stage 2 (required): { card_amount, paid_amount }").optional(),
      ...x402Fields,
    },
    async (params) => {
      try {
        const modeCode = params.mode_code ?? 100;
        if (modeCode === 200) {
          const hasX402 = params.x402_version !== undefined || params.payment_payload !== undefined || params.payment_requirements !== undefined;
          if (hasX402) {
            const missing: string[] = [];
            if (params.x402_version === undefined) missing.push("x402_version");
            if (params.payment_payload === undefined) missing.push("payment_payload");
            if (params.payment_requirements === undefined) missing.push("payment_requirements");
            if (params.extra === undefined) missing.push("extra (must include card_amount and paid_amount)");
            if (missing.length > 0) {
              return { content: [{ type: "text" as const, text: `Mode B Stage 2 missing required fields: ${missing.join(", ")}.` }], isError: true as const };
            }
          } else {
            if (!params.chain_code || !params.token_code) {
              return { content: [{ type: "text" as const, text: "Mode B Stage 1 requires chain_code and token_code." }], isError: true as const };
            }
          }
        }

        const body: Record<string, unknown> = {
          mode_code: modeCode,
          card_type: 100,
          amount: params.amount.toFixed(4),
          client_request_id: params.client_request_id ?? randomUUID(),
        };
        if (params.tx_limit) body.tx_limit = params.tx_limit;
        if (params.allowed_mcc) body.allowed_mcc = params.allowed_mcc;
        if (params.blocked_mcc) body.blocked_mcc = params.blocked_mcc;
        if (params.chain_code) body.chain_code = params.chain_code;
        if (params.token_code) body.token_code = params.token_code;
        if (params.x402_reference_id !== undefined) body.x402_reference_id = params.x402_reference_id;
        if (params.x402_version !== undefined) body.x402_version = params.x402_version;
        if (params.payment_payload !== undefined) body.payment_payload = params.payment_payload;
        if (params.payment_requirements !== undefined) body.payment_requirements = params.payment_requirements;
        if (params.extra !== undefined) body.extra = params.extra;
        if (params.payer_address !== undefined) body.payer_address = params.payer_address;

        const result = await client.post<unknown>("/payment/card-orders", body);
        return toolOk({
          ...(result as Record<string, unknown>),
          _hint: `Card created for: ${params.description}. Use get_card_details to retrieve card number for checkout.`,
        });
      } catch (err) {
        if (err instanceof ClawallexApiError && err.statusCode === 402 && err.details) {
          return formatX402Quote(err.details as Record<string, unknown>);
        }
        return toolError(err);
      }
    },
  );

  server.tool(
    "clawallex_subscribe",
    [
      "Set up a reloadable virtual card for recurring/subscription payments.",
      "Creates a stream card (card_type=200) that stays active and can be refilled via clawallex_refill.",
      "",
      "Mode A (mode_code=100, default): wallet balance → stream card. Immediate settlement.",
      "Mode B (mode_code=200): for callers with self-custody wallets — signing is performed by the caller. Same x402 two-stage flow as clawallex_pay.",
      "  The 402 response is EXPECTED (a quote, not an error). See clawallex_pay for full Stage 1/2 details.",
      "",
      "Fee structure: fee_amount = issue_fee_amount + monthly_fee_amount + fx_fee_amount.",
      "",
      "Example: clawallex_subscribe({ initial_amount: 100, description: 'AWS monthly billing' })",
    ].join("\n"),
    {
      initial_amount: z.number().describe("Initial deposit in USD"),
      description: z.string().describe("Subscription purpose"),
      mode_code: z.number().int().describe("100=wallet (default), 200=x402 on-chain").optional(),
      tx_limit: z.string().describe("Per-transaction limit in USD (optional, default 100.0000)").optional(),
      allowed_mcc: z.string().describe("MCC whitelist, comma-separated (optional, e.g. '5734,5815')").optional(),
      blocked_mcc: z.string().describe("MCC blacklist, comma-separated (optional, e.g. '7995')").optional(),
      client_request_id: z.string().max(64).describe("UUID idempotency key (<=64 chars). Mode B Stage 2: MUST reuse from Stage 1.").optional(),
      chain_code: z.string().describe("Chain code for Mode B Stage 1 (e.g. 'ETH')").optional(),
      token_code: z.string().describe("Token code for Mode B Stage 1 (e.g. 'USDC')").optional(),
      extra: z.record(z.unknown()).describe("Mode B Stage 2 (required): { card_amount, paid_amount }").optional(),
      ...x402Fields,
    },
    async (params) => {
      try {
        const modeCode = params.mode_code ?? 100;
        if (modeCode === 200) {
          const hasX402 = params.x402_version !== undefined || params.payment_payload !== undefined || params.payment_requirements !== undefined;
          if (hasX402) {
            const missing: string[] = [];
            if (params.x402_version === undefined) missing.push("x402_version");
            if (params.payment_payload === undefined) missing.push("payment_payload");
            if (params.payment_requirements === undefined) missing.push("payment_requirements");
            if (params.extra === undefined) missing.push("extra (must include card_amount and paid_amount)");
            if (missing.length > 0) {
              return { content: [{ type: "text" as const, text: `Mode B Stage 2 missing required fields: ${missing.join(", ")}.` }], isError: true as const };
            }
          } else {
            if (!params.chain_code || !params.token_code) {
              return { content: [{ type: "text" as const, text: "Mode B Stage 1 requires chain_code and token_code." }], isError: true as const };
            }
          }
        }

        const body: Record<string, unknown> = {
          mode_code: modeCode,
          card_type: 200,
          amount: params.initial_amount.toFixed(4),
          client_request_id: params.client_request_id ?? randomUUID(),
        };
        if (params.tx_limit) body.tx_limit = params.tx_limit;
        if (params.allowed_mcc) body.allowed_mcc = params.allowed_mcc;
        if (params.blocked_mcc) body.blocked_mcc = params.blocked_mcc;
        if (params.chain_code) body.chain_code = params.chain_code;
        if (params.token_code) body.token_code = params.token_code;
        if (params.x402_reference_id !== undefined) body.x402_reference_id = params.x402_reference_id;
        if (params.x402_version !== undefined) body.x402_version = params.x402_version;
        if (params.payment_payload !== undefined) body.payment_payload = params.payment_payload;
        if (params.payment_requirements !== undefined) body.payment_requirements = params.payment_requirements;
        if (params.extra !== undefined) body.extra = params.extra;
        if (params.payer_address !== undefined) body.payer_address = params.payer_address;

        const result = await client.post<unknown>("/payment/card-orders", body);
        return toolOk({
          ...(result as Record<string, unknown>),
          _hint: `Stream card created for: ${params.description}. Use clawallex_refill when balance is low.`,
        });
      } catch (err) {
        if (err instanceof ClawallexApiError && err.statusCode === 402 && err.details) {
          return formatX402Quote(err.details as Record<string, unknown>);
        }
        return toolError(err);
      }
    },
  );

  server.tool(
    "clawallex_refill",
    [
      "Top up the balance of a subscription (stream) card.",
      "Only stream cards (card_type=200) can be refilled. Refill mode follows the card's creation mode.",
      "",
      "Mode A: deducts from wallet balance. client_request_id is the idempotency key (auto-generated if omitted).",
      "Mode B: x402 settle (no 402 challenge stage) — agent must first call get_x402_payee_address to get payee_address,",
      "  then construct payment_requirements.payTo from it. Requires x402_reference_id, x402_version, payment_payload, payment_requirements.",
      "  Mode B idempotency key is x402_reference_id (not client_request_id).",
      "",
      "Tip: use get_card_balance first to check current balance.",
      "Example: clawallex_refill({ card_id: 'c_123', amount: 50 })",
    ].join("\n"),
    {
      card_id: z.string().describe("Stream card ID to refill"),
      amount: z.number().describe("Refill amount in USD"),
      client_request_id: z.string().max(64).describe("Mode A idempotency key (auto-generated if omitted)").optional(),
      ...x402Fields,
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = {
          amount: params.amount.toFixed(4),
          client_request_id: params.client_request_id ?? randomUUID(),
        };
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
