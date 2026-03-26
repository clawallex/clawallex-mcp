import { createHmac, createHash } from "node:crypto";

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ClawallexApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly endpoint?: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ClawallexApiError";
  }
}

export class ClawallexClient {
  private readonly basePath = "/api/v1";

  constructor(
    private readonly apiKey: string,
    private readonly apiSecret: string,
    private readonly baseUrl: string,
    private clientId: string,
  ) {}

  get baseUrlValue(): string {
    return this.baseUrl;
  }

  setClientId(id: string): void {
    this.clientId = id;
  }

  private sign(method: string, path: string, body: string, includeClientId = true): Record<string, string> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const bodyHash = createHash("sha256").update(body).digest("hex");
    const canonical = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
    const signature = createHmac("sha256", this.apiSecret)
      .update(canonical)
      .digest("base64");
    const headers: Record<string, string> = {
      "X-API-Key": this.apiKey,
      "X-Timestamp": timestamp,
      "X-Signature": signature,
      "Content-Type": "application/json",
    };
    if (includeClientId) {
      headers["X-Client-Id"] = this.clientId;
    }
    return headers;
  }

  /** GET /payment/* — requires X-Client-Id */
  async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const url = new URL(fullPath, this.baseUrl);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") {
          url.searchParams.set(k, String(v));
        }
      }
    }
    const headers = this.sign("GET", fullPath, "");
    const res = await fetch(url.toString(), { method: "GET", headers });
    return this.handleResponse<T>(res, path);
  }

  /** POST /payment/* — requires X-Client-Id */
  async post<T>(path: string, body: unknown): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const url = new URL(fullPath, this.baseUrl);
    const rawBody = JSON.stringify(body);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.sign("POST", fullPath, rawBody),
      body: rawBody,
    });
    return this.handleResponse<T>(res, path);
  }

  /** GET /auth/* — NO X-Client-Id */
  async getAuth<T>(path: string): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const url = new URL(fullPath, this.baseUrl);
    const res = await fetch(url.toString(), { method: "GET", headers: this.sign("GET", fullPath, "", false) });
    return this.handleResponse<T>(res, path);
  }

  /** POST /auth/* — NO X-Client-Id */
  async postAuth<T>(path: string, body: unknown): Promise<T> {
    const fullPath = `${this.basePath}${path}`;
    const url = new URL(fullPath, this.baseUrl);
    const rawBody = JSON.stringify(body);
    const res = await fetch(url.toString(), {
      method: "POST",
      headers: this.sign("POST", fullPath, rawBody, false),
      body: rawBody,
    });
    return this.handleResponse<T>(res, path);
  }

  get apiSecretValue(): string {
    return this.apiSecret;
  }

  private async handleResponse<T>(res: Response, endpoint: string): Promise<T> {
    const text = await res.text();
    if (!res.ok) {
      let code = "UNKNOWN_ERROR";
      let message = text;
      let details: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(text) as ApiError;
        code = parsed.code ?? code;
        message = parsed.message ?? message;
        details = parsed.details;
      } catch {
        // keep raw text as message
      }
      throw new ClawallexApiError(res.status, code, message, endpoint, details);
    }
    return JSON.parse(text) as T;
  }
}
