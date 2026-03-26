import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";

const CLIENT_IDS_FILE = join(homedir(), ".clawallex-mcp", "client_ids.json");

/**
 * Normalize baseUrl to a canonical key: lowercase scheme://host[:port].
 * Strips path, query, fragment, trailing slash, and default ports (80/443).
 */
export function normalizeBaseUrl(url: string): string {
  const parsed = new URL(url);
  const scheme = parsed.protocol.replace(":", "").toLowerCase();
  const host = parsed.hostname.toLowerCase();
  const isDefaultPort =
    (scheme === "https" && parsed.port === "443") ||
    (scheme === "http" && parsed.port === "80") ||
    parsed.port === "";
  const port = isDefaultPort ? "" : `:${parsed.port}`;
  return `${scheme}://${host}${port}`;
}

interface StoreResult {
  store: Record<string, string>;
  corrupt: boolean;
}

function readStore(): StoreResult {
  if (!existsSync(CLIENT_IDS_FILE)) {
    return { store: {}, corrupt: false };
  }
  try {
    const raw = readFileSync(CLIENT_IDS_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return { store: parsed as Record<string, string>, corrupt: false };
    }
    console.error(`[clawallex-mcp] ⚠ client_ids.json is not a valid object — please delete or fix: ${CLIENT_IDS_FILE}`);
    return { store: {}, corrupt: true };
  } catch {
    console.error(`[clawallex-mcp] ⚠ client_ids.json is corrupt (invalid JSON) — please delete or fix: ${CLIENT_IDS_FILE}`);
    return { store: {}, corrupt: true };
  }
}

function writeStore(store: Record<string, string>): void {
  mkdirSync(dirname(CLIENT_IDS_FILE), { recursive: true });
  writeFileSync(CLIENT_IDS_FILE, JSON.stringify(store, null, 2), "utf8");
}

/**
 * Resolve client ID with anti-drift logic:
 *   1. Existing entry in client_ids.json for this baseUrl (highest priority)
 *   2. Explicit fromArg (--client-id param)
 *   3. Generate new UUID v4 and persist
 *
 * Throws if client_ids.json exists but is corrupt — refuse to silently generate
 * a new identity which would cause drift.
 */
export function resolveClientId(baseUrl: string, fromArg?: string): string {
  const key = normalizeBaseUrl(baseUrl);
  const { store, corrupt } = readStore();

  const existing = store[key];
  if (existing && existing.trim().length > 0) {
    if (fromArg !== undefined && fromArg !== existing.trim()) {
      console.error(
        `[clawallex-mcp] ⚠ 忽略 --client-id 参数 (${fromArg})，使用本地已绑定的 client_id: ${existing.trim()}`,
      );
    }
    console.error(`[clawallex-mcp] 当前 client_id: ${existing.trim()} (from ${key})`);
    return existing.trim();
  }

  if (corrupt) {
    throw new Error(
      `client_ids.json is corrupt and no client_id could be read for ${key}. ` +
      `Please delete or fix ${CLIENT_IDS_FILE} before continuing.`,
    );
  }

  if (fromArg !== undefined && fromArg.trim().length > 0) {
    saveClientId(baseUrl, fromArg.trim());
    console.error(`[clawallex-mcp] 当前 client_id: ${fromArg.trim()} (from --client-id arg)`);
    return fromArg.trim();
  }

  const id = randomUUID();
  saveClientId(baseUrl, id);
  console.error(`[clawallex-mcp] 已生成新 client_id: ${id} (for ${key})`);
  return id;
}

export function saveClientId(baseUrl: string, id: string): void {
  const key = normalizeBaseUrl(baseUrl);
  const { store } = readStore();
  store[key] = id;
  writeStore(store);
}

export function currentClientId(baseUrl: string): string | null {
  const key = normalizeBaseUrl(baseUrl);
  const { store } = readStore();
  const val = store[key];
  return val && val.trim().length > 0 ? val.trim() : null;
}
