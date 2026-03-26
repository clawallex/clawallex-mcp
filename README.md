# @clawallex/mcp-server

MCP Server for the [Clawallex](https://clawallex.com) payment API. Pay for anything with USDC — Clawallex converts your stablecoin balance into virtual cards that work at any online checkout.

## Quick Start

### 1. Install

```bash
npm install -g @clawallex/mcp-server
```

Or use directly via `npx` (no install needed).

### 2. Get API Credentials

Sign up at [Clawallex](https://app.clawallex.com) and create an API Key pair (`api_key` + `api_secret`).

### 3. Configure Your AI Client

Choose your client and add the configuration:

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clawallex": {
      "command": "npx",
      "args": ["@clawallex/mcp-server"],
      "env": {
        "CLAWALLEX_API_KEY": "your_api_key",
        "CLAWALLEX_API_SECRET": "your_api_secret"
      }
    }
  }
}
```

#### Claude Code

```bash
claude mcp add --scope local clawallex -- npx @clawallex/mcp-server \
  --api-key your_api_key \
  --api-secret your_api_secret
```

#### Codex CLI

Add to your `~/.codex/config.toml` or `.codex/config.toml`:

```toml
[mcp_servers.clawallex]
command = "npx"
args = [
  "@clawallex/mcp-server",
  "--api-key",
  "your_api_key",
  "--api-secret",
  "your_api_secret",
]
```

#### Gemini CLI

Add to your `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "clawallex": {
      "command": "npx",
      "args": [
        "@clawallex/mcp-server",
        "--api-key", "your_api_key",
        "--api-secret", "your_api_secret"
      ]
    }
  }
}
```

#### OpenCode

Add to your `opencode.json`:

```json
{
  "mcp": {
    "clawallex": {
      "type": "local",
      "command": ["npx", "@clawallex/mcp-server", "--api-key", "your_api_key", "--api-secret", "your_api_secret"],
      "enabled": true
    }
  }
}
```

### 4. Initialize Connection

After configuring, tell your AI agent:

> "Run clawallex_setup to check the connection"

`clawallex_setup` verifies your API Key and automatically binds a `client_id` for data isolation. You only need to do this once.

### 5. Start Using

**One-time payment:**

> "Pay $50 for OpenAI API credits"

Agent calls `clawallex_pay` → creates virtual card → `get_card_details` → `decrypt_card_data` → fills checkout.

**Subscription:**

> "Set up a $100 card for AWS monthly billing"

Agent calls `clawallex_subscribe` → creates reloadable card → `clawallex_refill` when balance is low.

### 6. Smoke Test

Verify everything works:

```
clawallex_setup     → should show "ready" with bound client_id
get_wallet          → should return wallet balance
list_cards          → should return card list (empty if no cards yet)
```

## Typical Flows

### Payment Flow (Mode A — Wallet Balance)

```
1. clawallex_setup                           → verify connection & bind identity
2. get_wallet                                → check USDC balance
3. clawallex_pay({ amount, description })    → create a one-time virtual card
4. get_card_details({ card_id })             → get encrypted card data
5. decrypt_card_data({ nonce, ciphertext })  → decrypt PAN/CVV for checkout
```

### Subscription Flow

```
1. clawallex_setup                                          → verify connection
2. get_wallet                                               → check USDC balance
3. clawallex_subscribe({ initial_amount, description })     → create reloadable card
4. get_card_details({ card_id })                            → get card number
5. clawallex_refill({ card_id, amount })                    → top up when needed
```

## Tools

### High-Level (Recommended)

| Tool | Description |
|------|-------------|
| `clawallex_setup` | Check connection status and bind agent identity |
| `clawallex_pay` | One-time payment — creates a single-use virtual card |
| `clawallex_subscribe` | Recurring subscription — creates a reloadable card |
| `clawallex_refill` | Top up a subscription card balance |

### Identity & Binding

| Tool | Description |
|------|-------------|
| `whoami` | Query current API Key binding status (read-only) |
| `bootstrap` | Bind a client_id to this API Key |

### Wallet & Query

| Tool | Description |
|------|-------------|
| `get_wallet` | Get wallet balance and status |
| `get_wallet_recharge_addresses` | Get on-chain USDC deposit addresses |
| `list_cards` | List virtual cards created by this agent |
| `get_card_balance` | Get card balance and status |
| `batch_card_balances` | Check balances for multiple cards in one call |
| `update_card` | Update card risk controls (tx_limit, allowed_mcc, blocked_mcc) |
| `get_card_details` | Get card details including risk controls, cardholder info, and encrypted PAN/CVV |
| `decrypt_card_data` | Decrypt PAN/CVV from get_card_details |
| `list_transactions` | List card transactions with optional filters |

### Advanced (x402 On-Chain)

| Tool | Description |
|------|-------------|
| `get_x402_payee_address` | Get on-chain receiving address for x402 payments |
| `create_card_order` | Create a card with full control (supports Mode B two-stage) |
| `refill_card` | Refill a stream card with x402 or custom idempotency keys |

## CLI Options

| Option | Env Variable | Required | Default | Description |
|--------|-------------|----------|---------|-------------|
| `--api-key` | `CLAWALLEX_API_KEY` | Yes | — | Clawallex API Key |
| `--api-secret` | `CLAWALLEX_API_SECRET` | Yes | — | Clawallex API Secret (HMAC-SHA256 signing) |
| `--base-url` | `CLAWALLEX_BASE_URL` | No | `https://api.clawallex.com` | API base URL |
| `--client-id` | `CLAWALLEX_CLIENT_ID` | No | auto-generated | Agent identity UUID. See Client ID section. |
| `--transport` | — | No | `stdio` | Transport mode: `stdio`, `sse`, `http` |
| `--port` | — | No | `18080` | HTTP port for `sse` / `http` transport |

CLI arguments take precedence over environment variables. You can mix both — e.g. set credentials via env vars and override `--transport` via CLI.

## Requirements

- Node.js >= 22

## Client ID

`client_id` is the agent's stable identity, separate from the API Key. It is sent as `X-Client-Id` on every `/payment/*` request.

**Key concept:** An agent can have multiple API Keys (for rotation/revocation), but the `client_id` never changes. When switching to a new API Key, keep using the same `client_id` — the new key auto-binds on first request.

**Data isolation:**
- **Wallet**: user-level, shared — all agents using the same API key see the same wallet balance
- **Cards & Transactions**: `client_id`-scoped — each agent only sees data it created

**Binding rules:**
- `clawallex_setup` automatically calls `bootstrap` to bind `client_id` on first use
- Once bound, the `client_id` cannot be changed for that API Key (TOFU — Trust On First Use)
- Losing the `client_id` = losing access to all cards created under it

**Resolution order at startup:**
1. `--client-id <value>` CLI argument (must be >= 36 characters)
2. `~/.clawallex-mcp/client_ids.json` local file (from a previous run)
3. Auto-generate UUID v4 and save locally

**Recommendation:** Always pass `--client-id` explicitly in production to avoid relying on the local file.

## Transport Modes

### stdio (default — local agent / Claude Desktop)

```bash
npx @clawallex/mcp-server \
  --api-key your_api_key \
  --api-secret your_api_secret
```

### SSE (remote agent, compatible with older MCP clients)

```bash
npx @clawallex/mcp-server \
  --api-key your_api_key \
  --api-secret your_api_secret \
  --transport sse \
  --port 18080
```

Agent connects to: `http://localhost:18080/sse`

### Streamable HTTP (MCP SDK 1.0+ recommended)

```bash
npx @clawallex/mcp-server \
  --api-key your_api_key \
  --api-secret your_api_secret \
  --transport http \
  --port 18080
```

Agent connects to: `http://localhost:18080/mcp`

## Local Development

```bash
npm install
npm run build

# List all tools (stdio)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node dist/index.js \
    --api-key your_api_key \
    --api-secret your_api_secret \
  2>/dev/null
```

## Security

### Authentication

Every API request is signed with HMAC-SHA256:

```
canonical = METHOD + "\n" + PATH + "\n" + TIMESTAMP + "\n" + hex(sha256(body))
X-Signature = base64(hmac_sha256(api_secret, canonical))
```

Signing is handled automatically by the MCP server.

### Card Details Encryption

`get_card_details` returns `encrypted_sensitive_data` containing card PAN and CVV. Use `decrypt_card_data` to decrypt:

1. Derive key: `HKDF-SHA256(ikm=api_secret, info="clawallex/card-sensitive-data/v1", length=32)`
2. Decrypt: `AES-256-GCM(key, nonce, ciphertext)`
3. Result: `{ "pan": "4111...", "cvv": "123" }`

Decrypted PAN/CVV must NEVER be displayed to the user — only used for filling checkout forms.
