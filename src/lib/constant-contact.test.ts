import { describe, expect, it, vi } from "vitest";
import {
  createConstantContactProvider,
  isConstantContactConfigured,
} from "./constant-contact";

const STATIC_ENV = {
  CONSTANT_CONTACT_API_BASE_URL: "http://mock.test/v3/",
  CONSTANT_CONTACT_LIST_ID: "list-123",
  CONSTANT_CONTACT_ACCESS_TOKEN: "secret-static-token",
};
const REFRESH_ENV = {
  CONSTANT_CONTACT_API_BASE_URL: "http://mock.test/v3",
  CONSTANT_CONTACT_AUTH_BASE_URL: "http://mock.test/oauth2/default/v1",
  CONSTANT_CONTACT_LIST_ID: "list-123",
  CONSTANT_CONTACT_CLIENT_ID: "client-1",
  CONSTANT_CONTACT_REFRESH_TOKEN: "refresh-1",
};

function res(status: number, body: unknown = {}) {
  return new Response(JSON.stringify(body), { status });
}

describe("isConstantContactConfigured", () => {
  it("needs a list id and an auth method", () => {
    expect(isConstantContactConfigured({})).toBe(false);
    expect(isConstantContactConfigured({ CONSTANT_CONTACT_LIST_ID: "l" })).toBe(false);
    expect(isConstantContactConfigured(STATIC_ENV)).toBe(true);
    expect(isConstantContactConfigured(REFRESH_ENV)).toBe(true);
    expect(
      isConstantContactConfigured({
        CONSTANT_CONTACT_LIST_ID: "l",
        CONSTANT_CONTACT_CLIENT_ID: "c",
      }),
    ).toBe(false);
  });
});

describe("createConstantContactProvider", () => {
  it("reports unconfigured without any network call", async () => {
    const fetchMock = vi.fn();
    const provider = createConstantContactProvider({ env: () => ({}), fetch: fetchMock });
    expect(await provider.subscribe("a@example.test")).toEqual({ kind: "unconfigured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the contact to the configured base URL and list", async () => {
    const fetchMock = vi.fn(async () => res(201));
    const provider = createConstantContactProvider({ env: () => STATIC_ENV, fetch: fetchMock });
    expect(await provider.subscribe("a@example.test")).toEqual({ kind: "ok" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://mock.test/v3/contacts/sign_up_form");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-static-token",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      email_address: "a@example.test",
      list_memberships: ["list-123"],
      create_source: "Contact",
    });
  });

  it("treats 200 (existing contact) as ok", async () => {
    const provider = createConstantContactProvider({
      env: () => STATIC_ENV,
      fetch: vi.fn(async () => res(200)),
    });
    expect(await provider.subscribe("a@example.test")).toEqual({ kind: "ok" });
  });

  it.each([
    [400, "rejected"],
    [422, "rejected"],
    [403, "unavailable"],
    [404, "unavailable"],
    [401, "unavailable"],
    [429, "unavailable"],
    [500, "unavailable"],
    [503, "unavailable"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    const provider = createConstantContactProvider({
      env: () => STATIC_ENV,
      fetch: vi.fn(async () => res(status, { error_message: "leaky detail" })),
    });
    const result = await provider.subscribe("a@example.test");
    expect(result.kind).toBe(kind);
    expect(JSON.stringify(result)).not.toContain("leaky");
    expect(JSON.stringify(result)).not.toContain("secret-static-token");
  });

  it("maps network failures and timeouts to unavailable", async () => {
    const down = createConstantContactProvider({
      env: () => STATIC_ENV,
      fetch: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    });
    expect(await down.subscribe("a@example.test")).toEqual({
      kind: "unavailable",
      code: "network",
    });
    const slow = createConstantContactProvider({
      env: () => STATIC_ENV,
      fetch: vi.fn(async () => {
        throw new DOMException("timed out", "TimeoutError");
      }),
    });
    expect(await slow.subscribe("a@example.test")).toEqual({
      kind: "unavailable",
      code: "timeout",
    });
  });

  it("mints a token with the refresh grant and caches it", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/token")
        ? res(200, { access_token: "tok-1", expires_in: 86400 })
        : res(201),
    );
    const provider = createConstantContactProvider({
      env: () => REFRESH_ENV,
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.subscribe("a@example.test");
    await provider.subscribe("b@example.test");
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.endsWith("/token"))).toHaveLength(1);
    const tokenCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const params = new URLSearchParams(String(tokenCall[1].body));
    expect(params.get("grant_type")).toBe("refresh_token");
    expect(params.get("refresh_token")).toBe("refresh-1");
    const apiInit = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect((apiInit[1].headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
  });

  it("refreshes after expiry", async () => {
    let clock = 0;
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/token")
        ? res(200, { access_token: "tok", expires_in: 120 })
        : res(201),
    );
    const provider = createConstantContactProvider({
      env: () => REFRESH_ENV,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => clock,
    });
    await provider.subscribe("a@example.test");
    clock = 3_600_000;
    await provider.subscribe("a@example.test");
    expect(
      fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/token")),
    ).toHaveLength(2);
  });

  it("retries once with a fresh token on 401 and uses a rotated refresh token", async () => {
    let apiCalls = 0;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/token")) {
        const n = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/token")).length;
        return res(200, {
          access_token: `tok-${n}`,
          refresh_token: `refresh-${n + 1}`,
          expires_in: 86400,
        });
      }
      apiCalls += 1;
      expect(init).toBeDefined();
      return apiCalls === 1 ? res(401) : res(201);
    });
    const provider = createConstantContactProvider({
      env: () => REFRESH_ENV,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await provider.subscribe("a@example.test")).toEqual({ kind: "ok" });
    expect(apiCalls).toBe(2);
    const secondToken = fetchMock.mock.calls.filter((c) =>
      String(c[0]).endsWith("/token"),
    )[1] as unknown as [string, RequestInit];
    expect(new URLSearchParams(String(secondToken[1].body)).get("refresh_token")).toBe(
      "refresh-2",
    );
  });

  it("does not retry 401 forever", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith("/token") ? res(200, { access_token: "t", expires_in: 86400 }) : res(401),
    );
    const provider = createConstantContactProvider({
      env: () => REFRESH_ENV,
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect((await provider.subscribe("a@example.test")).kind).toBe("unavailable");
    expect(fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/token"))).toHaveLength(2);
  });

  it("is unavailable when the token endpoint refuses", async () => {
    const provider = createConstantContactProvider({
      env: () => REFRESH_ENV,
      fetch: vi.fn(async () => res(400)),
    });
    expect(await provider.subscribe("a@example.test")).toEqual({
      kind: "unavailable",
      code: "no_token",
    });
  });
});
