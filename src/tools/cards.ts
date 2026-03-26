import { z } from "zod";
import { hkdfSync, createDecipheriv } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient, ClawallexApiError } from "../client.js";
import { toolError, toolOk, formatX402Quote } from "./utils.js";

const HKDF_INFO = "clawallex/card-sensitive-data/v1";

export const x402Fields = {
  x402_reference_id: z.string().describe("x402 reference ID. Card creation Stage 1: optional (server generates if omitted). Stage 2: use value from 402 response. Refill Mode B: required, serves as idempotency key.").optional(),
  x402_version: z.number().int().describe("x402 version (Mode B Stage 2, required)").optional(),
  payment_payload: z
    .record(z.unknown())
    .describe("x402 payment payload (Mode B Stage 2, required)")
    .optional(),
  payment_requirements: z
    .record(z.unknown())
    .describe("x402 payment requirements (Mode B Stage 2, required)")
    .optional(),
  payer_address: z.string().describe("Payer wallet address (optional, final value from verify)").optional(),
};

export function registerCardTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "create_card_order",
    [
      "Advanced: create a virtual card with full control over payment mode and card type.",
      "Maps directly to POST /payment/card-orders. Most agents should use clawallex_pay or clawallex_subscribe instead.",
      "",
      "Mode A (mode_code=100): wallet balance deduction, immediate settlement.",
      "Mode B (mode_code=200): for callers with self-custody wallets — signing is performed by the caller. x402 two-stage flow:",
      "  Stage 1 (Quote): provide chain_code + token_code. The 402 response is EXPECTED (a quote, NOT an error).",
      "    Returns: payee_address, asset_address, x402_reference_id, fee breakdown, payable_amount.",
      "  Agent signs: construct and sign an EIP-3009 transferWithAuthorization using your own wallet/signing library.",
      "    Stage 2 requires the resulting signature and your wallet address (authorization.from).",
      "    authorization fields: from=your wallet, to=payee_address, value=maxAmountRequired,",
      "    validAfter/validBefore=unix seconds validity window, nonce=random 32-byte hex (unique per auth).",
      "  Stage 2 (Settle): reuse SAME client_request_id + provide x402_version, payment_payload, payment_requirements, extra.",
      "    - payment_requirements.payTo MUST equal payee_address from Stage 1",
      "    - payment_requirements.asset MUST equal asset_address from Stage 1",
      "    - maxAmountRequired = payable_amount × 10^decimals (USDC = 6, e.g. '207.59' → '207590000').",
      "  If settle rejected, order stays pending_payment — retry with same client_request_id.",
      "",
      "card_type: 100=flash (single-use), 200=stream (reloadable).",
      "Fee: flash = issue_fee + fx_fee; stream = issue_fee + monthly_fee + fx_fee.",
    ].join("\n"),
    {
      mode_code: z
        .number()
        .int()
        .describe("Payment mode: 100=Mode A (wallet balance), 200=Mode B (x402 on-chain USDC)"),
      card_type: z
        .number()
        .int()
        .describe("Card type: 100=flash (single-use), 200=stream (reloadable via refill_card)"),
      amount: z.string().describe("Card face amount in USD, decimal string e.g. '100.0000'"),
      client_request_id: z
        .string()
        .max(64)
        .describe("UUID idempotency key — MUST be same for both Stage 1 and Stage 2"),
      fee_amount: z
        .string()
        .describe("Fee amount in USD (optional, must match server-calculated fee if provided)")
        .optional(),
      tx_limit: z.string().describe("Per-transaction limit in USD (optional, default 100.0000)").optional(),
      allowed_mcc: z.string().describe("MCC whitelist, comma-separated (optional, e.g. '5734,5815')").optional(),
      blocked_mcc: z.string().describe("MCC blacklist, comma-separated (optional, e.g. '7995')").optional(),
      chain_code: z.string().describe("Chain code for Mode B Stage 1 (e.g. 'ETH', 'BASE')").optional(),
      token_code: z.string().describe("Token code for Mode B Stage 1 (e.g. 'USDC')").optional(),
      extra: z.record(z.unknown()).describe("Mode B Stage 2: { card_amount, paid_amount }").optional(),
      ...x402Fields,
    },
    async (params) => {
      try {
        if (params.mode_code === 200) {
          const hasX402Fields = params.x402_version !== undefined || params.payment_payload !== undefined || params.payment_requirements !== undefined;
          if (hasX402Fields) {
            const missing: string[] = [];
            if (params.x402_version === undefined) missing.push("x402_version");
            if (params.payment_payload === undefined) missing.push("payment_payload");
            if (params.payment_requirements === undefined) missing.push("payment_requirements");
            if (params.extra === undefined) missing.push("extra (must include card_amount and paid_amount)");
            if (missing.length > 0) {
              return { content: [{ type: "text" as const, text: `Mode B Stage 2 missing required fields: ${missing.join(", ")}. All x402 fields are required for settlement.` }], isError: true as const };
            }
          } else {
            if (!params.chain_code || !params.token_code) {
              return { content: [{ type: "text" as const, text: "Mode B Stage 1 requires chain_code and token_code (e.g. chain_code='ETH', token_code='USDC')." }], isError: true as const };
            }
          }
        }
        const body: Record<string, unknown> = {
          mode_code: params.mode_code,
          card_type: params.card_type,
          amount: params.amount,
          client_request_id: params.client_request_id,
        };
        if (params.fee_amount !== undefined) body.fee_amount = params.fee_amount;
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
        return toolOk(result);
      } catch (err) {
        // Mode B Stage 1: 402 is the challenge response, not an error
        if (err instanceof ClawallexApiError && err.statusCode === 402 && err.details) {
          return formatX402Quote(err.details as Record<string, unknown>);
        }
        return toolError(err);
      }
    },
  );

  server.tool(
    "list_cards",
    [
      "List virtual cards created by this agent (scoped to the server's client_id).",
      "Cards created by other agents using the same API key are not visible.",
      "Returns: card_id, mode_code (100=Mode A, 200=Mode B), card_type (flash/stream), status, masked PAN, balance, and expiry.",
      "Tip: check mode_code to determine refill path — Mode A uses wallet balance, Mode B uses x402 on-chain.",
    ].join("\n"),
    {
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
    async ({ page, page_size }) => {
      try {
        const query: Record<string, string | number> = {};
        if (page !== undefined) query.page = page;
        if (page_size !== undefined) query.page_size = page_size;
        const result = await client.get<unknown>("/payment/cards", query);
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "get_card_balance",
    [
      "Get the current balance and status of a virtual card.",
      "Only cards created by this agent (same client_id) are accessible.",
      "Returns available_balance, card_currency, status, and updated_at.",
    ].join(" "),
    { card_id: z.string().describe("Card ID, e.g. 'c_123'") },
    async ({ card_id }) => {
      try {
        const result = await client.get<unknown>(`/payment/cards/${card_id}/balance`);
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "batch_card_balances",
    "Check balances for multiple cards in one call.",
    {
      card_ids: z.array(z.string()).describe("Array of card IDs"),
    },
    async ({ card_ids }) => {
      try {
        return toolOk(await client.post<unknown>("/payment/cards/balances", { card_ids }));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "update_card",
    [
      "Update card risk controls: per-transaction limit and MCC whitelist/blacklist.",
      "At least one field must be provided. Changes take effect after issuer confirms.",
    ].join("\n"),
    {
      card_id: z.string().describe("Card ID to update"),
      client_request_id: z.string().max(64).describe("UUID idempotency key"),
      tx_limit: z.string().describe("Per-transaction limit in USD (e.g. '200.0000')").optional(),
      allowed_mcc: z.string().describe("MCC whitelist, comma-separated (e.g. '5734,5815')").optional(),
      blocked_mcc: z.string().describe("MCC blacklist, comma-separated (e.g. '7995')").optional(),
    },
    async (params) => {
      try {
        const body: Record<string, unknown> = { client_request_id: params.client_request_id };
        if (params.tx_limit) body.tx_limit = params.tx_limit;
        if (params.allowed_mcc) body.allowed_mcc = params.allowed_mcc;
        if (params.blocked_mcc) body.blocked_mcc = params.blocked_mcc;
        return toolOk(await client.post<unknown>(`/payment/cards/${params.card_id}/update`, body));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "get_card_details",
    [
      "Get full card details including masked PAN, expiry, balance, cardholder info, billing address, risk controls, and encrypted sensitive data.",
      "Returns: masked_pan, expiry, balance, status, first_name, last_name, delivery_address, tx_limit, allowed_mcc, blocked_mcc, encrypted_sensitive_data.",
      "The encrypted_sensitive_data field contains PAN and CVV encrypted with AES-256-GCM.",
      "To decrypt, use the decrypt_card_data tool with the encrypted_sensitive_data object.",
      "Only cards created by this agent (same client_id) are accessible.",
      "IMPORTANT: Never display the decrypted PAN or CVV to the user. Use them only for filling checkout forms.",
    ].join(" "),
    { card_id: z.string().describe("Card ID, e.g. 'c_123'") },
    async ({ card_id }) => {
      try {
        const result = await client.get<Record<string, unknown>>(`/payment/cards/${card_id}/details`);
        if (!result.encrypted_sensitive_data) {
          return toolOk({
            ...result,
            _hint: "encrypted_sensitive_data is null. Possible reasons: (1) issuer did not return sensitive data for this card, (2) environment has sensitive data disabled, (3) insufficient permissions. Check card status and contact support if needed.",
          });
        }
        return toolOk({
          ...result,
          _hint: "Use decrypt_card_data with the encrypted_sensitive_data to get PAN and CVV for checkout. NEVER display the decrypted card number or CVV to the user.",
        });
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "decrypt_card_data",
    [
      "Decrypt the encrypted_sensitive_data from get_card_details to obtain PAN and CVV.",
      "Input: the nonce and ciphertext fields from encrypted_sensitive_data.",
      "Output: { pan, cvv } — the full card number and security code.",
      "Decryption: HKDF-SHA256(api_secret, info='clawallex/card-sensitive-data/v1') → AES-256-GCM.",
      "SECURITY: The decrypted PAN and CVV are STRICTLY for filling checkout/payment forms.",
      "NEVER display, log, or return the raw card number or CVV to the user.",
      "NEVER include PAN/CVV in conversation text shown to the user.",
      "If the user asks to see their card number, show only the masked_pan from get_card_details.",
    ].join(" "),
    {
      nonce: z.string().describe("The nonce field from encrypted_sensitive_data (base64 encoded)"),
      ciphertext: z.string().describe("The ciphertext field from encrypted_sensitive_data (base64 encoded)"),
    },
    async ({ nonce, ciphertext }) => {
      try {
        const key = Buffer.from(hkdfSync("sha256", client.apiSecretValue, Buffer.alloc(0), HKDF_INFO, 32));
        const nonceBuf = Buffer.from(nonce, "base64");
        const ciphertextBuf = Buffer.from(ciphertext, "base64");
        // AES-GCM: last 16 bytes of ciphertext are the auth tag
        const authTag = ciphertextBuf.subarray(ciphertextBuf.length - 16);
        const encrypted = ciphertextBuf.subarray(0, ciphertextBuf.length - 16);
        const decipher = createDecipheriv("aes-256-gcm", key, nonceBuf);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
        const { pan, cvv } = JSON.parse(decrypted.toString("utf8")) as { pan: string; cvv: string };
        return toolOk({
          pan,
          cvv,
          _hint: "SECURITY: Use these values ONLY to fill checkout forms. NEVER display the full PAN or CVV to the user. If the user asks for their card number, show only the masked_pan from get_card_details.",
        });
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Decryption failed: ${err instanceof Error ? err.message : String(err)}. Ensure you passed the exact nonce and ciphertext from get_card_details encrypted_sensitive_data.` }],
          isError: true as const,
        };
      }
    },
  );

}
