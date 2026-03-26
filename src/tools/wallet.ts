import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ClawallexClient, ClawallexApiError } from "../client.js";
import { toolError, toolOk } from "./utils.js";

interface WalletDetail {
  wallet_id: string;
  wallet_type: number;
  currency: string;
  available_balance: string;
  frozen_balance: string;
  low_balance_threshold: string;
  status: number;
  updated_at: string;
}

interface X402PayeeAddress {
  chain_code: string;
  token_code: string;
  address: string;
}

interface RechargeAddress {
  recharge_address_id: string;
  wallet_id: string;
  chain_code: string;
  token_code: string;
  address_type: number;
  address: string;
  memo_tag: string;
  status: number;
  updated_at: string;
}

interface RechargeAddressesResponse {
  wallet_id: string;
  total: number;
  data: RechargeAddress[];
}

export function registerWalletTools(server: McpServer, client: ClawallexClient): void {
  server.tool(
    "get_wallet",
    [
      "Get the wallet details for the current API key.",
      "Each API key has exactly one wallet — shared across all agents using the same API key.",
      "Returns available_balance, frozen_balance, low_balance_threshold, currency (USD), and status.",
      "Use this to check if there is sufficient balance before creating cards (Mode A) or refilling (Mode A).",
    ].join(" "),
    {},
    async () => {
      try {
        const result = await client.get<WalletDetail>("/payment/wallets/detail");
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );

  server.tool(
    "get_x402_payee_address",
    [
      "Get the system receiving address for x402 on-chain payments.",
      "",
      "When to use: MUST call this before Mode B Refill to obtain payee_address for payment_requirements.payTo.",
      "Not needed for Mode B card creation — the 402 quote response already includes payee_address.",
      "",
      "Common chain + token combinations: BASE + USDC, ETH + USDC.",
      "If this returns 404: the payee address for this chain/token is not initialized — try a different chain or contact support.",
    ].join("\n"),
    {
      chain_code: z.string().describe("Chain code, e.g. 'ETH', 'BASE'"),
      token_code: z.string().describe("Token code, e.g. 'USDC'"),
    },
    async ({ chain_code, token_code }) => {
      try {
        const result = await client.get<X402PayeeAddress>("/payment/x402/payee-address", {
          chain_code,
          token_code,
        });
        return toolOk(result);
      } catch (err) {
        if (err instanceof ClawallexApiError && err.statusCode === 404) {
          return {
            content: [{ type: "text" as const, text:
              `No payee address found for ${chain_code} + ${token_code}. ` +
              "The payee address for this chain/token combination has not been initialized. " +
              "Common combinations: ETH + USDC. " +
              "Contact support to enable this chain."
            }],
            isError: true as const,
          };
        }
        return toolError(err);
      }
    },
  );

  server.tool(
    "get_wallet_recharge_addresses",
    [
      "Get the on-chain deposit addresses for a wallet.",
      "Send USDC to one of these addresses to top up the wallet balance.",
      "Each address is specific to a chain (e.g. BASE) and token (e.g. USDC).",
      "For Mode B (x402) card creation/refill, the system automatically selects the acquiring address — you do not need to call this manually.",
    ].join(" "),
    { wallet_id: z.string().describe("Wallet ID returned by get_wallet, e.g. 'w_123'") },
    async ({ wallet_id }) => {
      try {
        const result = await client.get<RechargeAddressesResponse>(
          `/payment/wallets/${wallet_id}/recharge-addresses`,
        );
        if (result.data && result.data.length === 0) {
          return toolOk({
            ...result,
            _hint: "No recharge addresses found. Possible reasons: recharge address pool not enabled for this wallet, chain not activated, or test environment limitation. Contact support if this is unexpected.",
          });
        }
        return toolOk(result);
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
