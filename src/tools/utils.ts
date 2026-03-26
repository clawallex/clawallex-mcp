import { ClawallexApiError } from "../client.js";

export function toolError(err: unknown): { content: Array<{ type: "text"; text: string }>; isError: true } {
  if (err instanceof ClawallexApiError) {
    const parts = [`API Error ${err.statusCode} [${err.code}]: ${err.message}`];
    if (err.endpoint) parts.push(`Endpoint: ${err.endpoint}`);
    return {
      content: [{ type: "text", text: parts.join("\n") }],
      isError: true,
    };
  }
  return {
    content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

export function toolOk(data: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/**
 * Format a 402 Mode B challenge into a structured quote with a ready-to-fill Stage 2 template.
 */
export function formatX402Quote(details: Record<string, unknown>) {
  const payable = details.payable_amount as string | undefined;
  const maxAmount = payable
    ? String(Math.round(parseFloat(payable) * 1_000_000))
    : "<payable_amount × 10^6>";

  return toolOk({
    _stage: "quote",
    _status: 402,
    ...details,
    _hint: [
      "Mode B Stage 1 complete — 402 Payment Required (this is expected, not an error).",
      "",
      "Next: sign an EIP-3009 transferWithAuthorization using your own wallet/signing library, then call again with EXACTLY this structure:",
    ].join("\n"),
    _stage2_template: {
      client_request_id: details.client_request_id,
      x402_version: 1,
      payment_payload: {
        scheme: "exact",
        network: "<chain network, e.g. 'ETH'>",
        payload: {
          signature: "<your EIP-3009 signature hex>",
          authorization: {
            from: "<your wallet address>",
            to: details.payee_address,
            value: maxAmount,
            validAfter: "<unix seconds, e.g. now - 60>",
            validBefore: "<unix seconds, e.g. now + 3600>",
            nonce: "<random 32-byte hex, unique per auth>",
          },
        },
      },
      payment_requirements: {
        scheme: "exact",
        network: "<chain network, e.g. 'ETH'>",
        asset: details.asset_address,
        payTo: details.payee_address,
        maxAmountRequired: maxAmount,
        extra: {
          referenceId: details.x402_reference_id,
        },
      },
      extra: {
        card_amount: details.final_card_amount,
        paid_amount: details.payable_amount,
      },
    },
  });
}
