/**
 * Constant Contact v3 provider (#164). Server-side only: it reads secrets
 * from server env vars (never NEXT_PUBLIC_*) and must not be imported from a
 * client component. Nothing here logs or returns secrets, tokens, provider
 * response bodies or the visitor's email; failures are reduced to a short code.
 *
 * Env:
 *   CONSTANT_CONTACT_API_BASE_URL   default https://api.cc.email/v3 (tests/Docker use a mock)
 *   CONSTANT_CONTACT_LIST_ID        list the contact is added to
 *   CONSTANT_CONTACT_ACCESS_TOKEN   static bearer token, or
 *   CONSTANT_CONTACT_CLIENT_ID + CONSTANT_CONTACT_REFRESH_TOKEN
 *     (+ optional CONSTANT_CONTACT_CLIENT_SECRET, CONSTANT_CONTACT_AUTH_BASE_URL)
 *     to mint short-lived tokens via the OAuth2 refresh grant.
 */
import type { NewsletterProvider, ProviderResult } from "@/lib/newsletter";

export const DEFAULT_CONSTANT_CONTACT_API_BASE_URL = "https://api.cc.email/v3";
export const DEFAULT_CONSTANT_CONTACT_AUTH_BASE_URL =
  "https://authz.constantcontact.com/oauth2/default/v1";
export const CONSTANT_CONTACT_TIMEOUT_MS = 8000;

type Env = Record<string, string | undefined>;

type ConstantContactDeps = {
  env?: () => Env;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

function clean(value: string | undefined): string {
  return (value ?? "").trim();
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function isConstantContactConfigured(env: Env = process.env): boolean {
  if (!clean(env.CONSTANT_CONTACT_LIST_ID)) return false;
  return (
    Boolean(clean(env.CONSTANT_CONTACT_ACCESS_TOKEN)) ||
    Boolean(
      clean(env.CONSTANT_CONTACT_CLIENT_ID) &&
        clean(env.CONSTANT_CONTACT_REFRESH_TOKEN),
    )
  );
}

export function createConstantContactProvider(
  deps: ConstantContactDeps = {},
): NewsletterProvider {
  const getEnv = deps.env ?? (() => process.env);
  const doFetch = deps.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? CONSTANT_CONTACT_TIMEOUT_MS;

  let cachedToken: { value: string; expiresAt: number } | null = null;
  // Providers may rotate the refresh token; keep the newest one in memory.
  let rotatedRefreshToken: string | null = null;

  async function request(url: string, init: RequestInit): Promise<Response> {
    return doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  }

  async function refreshAccessToken(env: Env): Promise<string | null> {
    const clientId = clean(env.CONSTANT_CONTACT_CLIENT_ID);
    const refreshToken =
      rotatedRefreshToken ?? clean(env.CONSTANT_CONTACT_REFRESH_TOKEN);
    if (!clientId || !refreshToken) return null;

    const authBase = trimSlash(
      clean(env.CONSTANT_CONTACT_AUTH_BASE_URL) ||
        DEFAULT_CONSTANT_CONTACT_AUTH_BASE_URL,
    );
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    const secret = clean(env.CONSTANT_CONTACT_CLIENT_SECRET);
    if (secret) {
      headers.Authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    });

    const response = await request(`${authBase}/token`, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    if (!response.ok) return null;
    const json = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    } | null;
    if (!json || typeof json.access_token !== "string" || !json.access_token) {
      return null;
    }
    if (typeof json.refresh_token === "string" && json.refresh_token) {
      rotatedRefreshToken = json.refresh_token;
    }
    const ttl = typeof json.expires_in === "number" ? json.expires_in : 3600;
    // Renew a minute early.
    cachedToken = {
      value: json.access_token,
      expiresAt: now() + Math.max(ttl - 60, 30) * 1000,
    };
    return cachedToken.value;
  }

  async function getToken(env: Env, forceRefresh: boolean): Promise<string | null> {
    const staticToken = clean(env.CONSTANT_CONTACT_ACCESS_TOKEN);
    if (staticToken) return staticToken;
    if (!forceRefresh && cachedToken && cachedToken.expiresAt > now()) {
      return cachedToken.value;
    }
    return refreshAccessToken(env);
  }

  async function post(
    env: Env,
    email: string,
    forceRefresh: boolean,
  ): Promise<ProviderResult> {
    const token = await getToken(env, forceRefresh);
    if (!token) return { kind: "unavailable", code: "no_token" };

    const base = trimSlash(
      clean(env.CONSTANT_CONTACT_API_BASE_URL) ||
        DEFAULT_CONSTANT_CONTACT_API_BASE_URL,
    );
    const response = await request(`${base}/contacts/sign_up_form`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email_address: email,
        list_memberships: [clean(env.CONSTANT_CONTACT_LIST_ID)],
        create_source: "Contact",
      }),
    });

    if (response.status === 200 || response.status === 201) {
      return { kind: "ok" };
    }
    if (
      response.status === 401 &&
      !forceRefresh &&
      !clean(env.CONSTANT_CONTACT_ACCESS_TOKEN) &&
      clean(env.CONSTANT_CONTACT_CLIENT_ID)
    ) {
      cachedToken = null;
      return post(env, email, true);
    }
    // Only 400/422 mean "this email is the problem"; other 4xx (bad list id,
    // permissions, expired credentials) are our configuration and stay transient
    // from the visitor's point of view.
    if (response.status === 400 || response.status === 422) {
      return { kind: "rejected", code: `http_${response.status}` };
    }
    return { kind: "unavailable", code: `http_${response.status}` };
  }

  return {
    async subscribe(email: string): Promise<ProviderResult> {
      const env = getEnv();
      if (!isConstantContactConfigured(env)) return { kind: "unconfigured" };
      try {
        return await post(env, email, false);
      } catch (error) {
        const timedOut =
          error instanceof Error &&
          (error.name === "TimeoutError" || error.name === "AbortError");
        return { kind: "unavailable", code: timedOut ? "timeout" : "network" };
      }
    },
  };
}

let defaultProvider: NewsletterProvider | null = null;

/** Process-wide provider (keeps the token cache between requests). */
export function getConstantContactProvider(): NewsletterProvider {
  defaultProvider ??= createConstantContactProvider();
  return defaultProvider;
}
