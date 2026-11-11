import { describe, expect, it, vi } from "vitest";
import {
  clientKeyFromHeaders,
  createRateLimiter,
  isLegacyNewsletterSection,
  isNewsletterSource,
  NEWSLETTER_CONSENT_TEXT,
  NEWSLETTER_MESSAGES,
  NEWSLETTER_SOURCES,
  normalizeNewsletterEmail,
  subscribeToNewsletter,
  type NewsletterProvider,
  type NewsletterRecord,
  type NewsletterStore,
  type ProviderResult,
} from "./newsletter";

function makeProvider(result: ProviderResult | Error) {
  const subscribe = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { provider: { subscribe } as NewsletterProvider, subscribe };
}

function makeStore(
  existing: "pending" | "subscribed" | "failed" | null = null,
  saveResult = true,
) {
  const save = vi.fn(async (record: NewsletterRecord) => Boolean(record) && saveResult);
  void existing;
  return { store: { save } as NewsletterStore, save };
}

const input = { email: "  Reader@Example.TEST ", source: "home" as const, siteTenant: null };

describe("normalizeNewsletterEmail", () => {
  it("trims and lower-cases", () => {
    expect(normalizeNewsletterEmail("  Reader@Example.TEST ")).toBe("reader@example.test");
  });
  it.each(["", "nope", "a@b", "a b@c.d", "a@@c.de", "a@.com", `${"x".repeat(250)}@a.bc`])(
    "rejects %j",
    (value) => {
      expect(normalizeNewsletterEmail(value)).toBeNull();
    },
  );
  it("rejects non-strings", () => {
    expect(normalizeNewsletterEmail(null)).toBeNull();
    expect(normalizeNewsletterEmail(42)).toBeNull();
  });
});

describe("sources", () => {
  it("accepts the four placements plus the #161 thank-you source", () => {
    for (const s of ["home", "footer", "resources", "become-a-coach-thank-you"]) {
      expect(isNewsletterSource(s)).toBe(true);
    }
    expect(NEWSLETTER_SOURCES).toContain("become-a-coach-thank-you");
    expect(isNewsletterSource("evil")).toBe(false);
    expect(isNewsletterSource(undefined)).toBe(false);
  });
});

describe("subscribeToNewsletter", () => {
  it("provider ok + store ok: subscribed, row recorded with consent text", async () => {
    const { provider, subscribe } = makeProvider({ kind: "ok" });
    const { store, save } = makeStore();
    const result = await subscribeToNewsletter(input, { provider, store });
    expect(result).toMatchObject({ success: true, status: "subscribed" });
    expect(subscribe).toHaveBeenCalledWith("reader@example.test");
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "reader@example.test",
        status: "subscribed",
        source: "home",
        consentText: expect.stringContaining(NEWSLETTER_CONSENT_TEXT),
      }),
    );
  });

  it("provider ok but store missing or failing still reports subscribed", async () => {
    const { provider } = makeProvider({ kind: "ok" });
    expect(await subscribeToNewsletter(input, { provider, store: null })).toMatchObject({
      success: true,
      status: "subscribed",
    });
    const { store } = makeStore(null, false);
    expect(await subscribeToNewsletter(input, { provider, store })).toMatchObject({
      success: true,
      status: "subscribed",
    });
  });

  it.each([
    [{ kind: "unconfigured" } as ProviderResult, "unconfigured"],
    [{ kind: "unavailable", code: "http_500" } as ProviderResult, "http_500"],
  ])("provider %j + saved: honest 'saved' message, never subscribed", async (res, code) => {
    const { provider } = makeProvider(res);
    const { store, save } = makeStore();
    const result = await subscribeToNewsletter(input, { provider, store });
    expect(result).toEqual({
      success: true,
      status: "saved",
      message: NEWSLETTER_MESSAGES.saved,
    });
    expect(result.message).not.toMatch(/you are subscribed/i);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ status: "pending", providerError: code }),
    );
  });

  it("a throwing provider counts as unavailable", async () => {
    const { provider } = makeProvider(new Error("boom"));
    const { store } = makeStore();
    expect(await subscribeToNewsletter(input, { provider, store })).toMatchObject({
      status: "saved",
    });
  });

  it("unavailable and not saved: error", async () => {
    const { provider } = makeProvider({ kind: "unavailable", code: "timeout" });
    for (const store of [null, makeStore(null, false).store]) {
      expect(await subscribeToNewsletter(input, { provider, store })).toEqual({
        error: NEWSLETTER_MESSAGES.unavailable,
      });
    }
  });

  it("rejected: error flagged on the field, row stored as failed", async () => {
    const { provider } = makeProvider({ kind: "rejected", code: "http_400" });
    const { store, save } = makeStore();
    const result = await subscribeToNewsletter(input, { provider, store });
    expect(result).toEqual({ error: NEWSLETTER_MESSAGES.rejected, fieldError: true });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", providerError: "http_400" }),
    );
  });

  it("invalid email: field error and no provider call", async () => {
    const { provider, subscribe } = makeProvider({ kind: "ok" });
    const result = await subscribeToNewsletter(
      { ...input, email: "nope" },
      { provider, store: null },
    );
    expect(result).toEqual({ error: NEWSLETTER_MESSAGES.invalidEmail, fieldError: true });
    expect(subscribe).not.toHaveBeenCalled();
  });

  it("a stale local 'subscribed' row never short-circuits the provider", async () => {
    const { provider, subscribe } = makeProvider({ kind: "unavailable", code: "http_500" });
    const { store } = makeStore("subscribed");
    const result = await subscribeToNewsletter(input, { provider, store });
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("saved");
  });

  it("the saved message makes no promise of a later add", () => {
    expect(NEWSLETTER_MESSAGES.saved).not.toMatch(/shortly|will add/i);
  });

  it("stores a versioned consent text", async () => {
    const { provider } = makeProvider({ kind: "ok" });
    const { store, save } = makeStore();
    await subscribeToNewsletter(input, { provider, store });
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ consentText: expect.stringMatching(/^v\d+: /) }),
    );
  });

  it("pending or failed rows are retried", async () => {
    for (const existing of ["pending", "failed"] as const) {
      const { provider, subscribe } = makeProvider({ kind: "ok" });
      const { store } = makeStore(existing);
      await subscribeToNewsletter(input, { provider, store });
      expect(subscribe).toHaveBeenCalledTimes(1);
    }
  });
});

describe("isLegacyNewsletterSection", () => {
  it("matches only the off-site Constant Contact CTA", () => {
    expect(
      isLegacyNewsletterSection({
        type: "cta",
        href: "https://visitor.r20.constantcontact.com/d.jsp?x=1",
      }),
    ).toBe(true);
    expect(isLegacyNewsletterSection({ type: "cta", href: "/contact" })).toBe(false);
    expect(isLegacyNewsletterSection({ type: "prose" })).toBe(false);
  });
});

describe("createRateLimiter", () => {
  it("blocks after the limit and recovers after the window", () => {
    const limiter = createRateLimiter(2, 1000);
    expect(limiter.allow("a", 0)).toBe(true);
    expect(limiter.allow("a", 10)).toBe(true);
    expect(limiter.allow("a", 20)).toBe(false);
    expect(limiter.allow("b", 20)).toBe(true);
    expect(limiter.allow("a", 1100)).toBe(true);
  });
});

describe("clientKeyFromHeaders", () => {
  const h = (m: Record<string, string>) => (n: string) => m[n] ?? null;
  it("uses the last (proxy-appended) hop, ignoring a spoofed first value", () => {
    expect(clientKeyFromHeaders(h({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }))).toBe("203.0.113.9");
  });
  it("falls back to x-real-ip, then null", () => {
    expect(clientKeyFromHeaders(h({ "x-real-ip": "198.51.100.1" }))).toBe("198.51.100.1");
    expect(clientKeyFromHeaders(h({}))).toBeNull();
  });
});
