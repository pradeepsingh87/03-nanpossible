import { afterEach, describe, expect, it, vi } from "vitest";
import {
  analyticsSiteTenant,
  analyticsTrafficType,
  beginCheckoutEvent,
  beginDonationEvent,
  buildGlobalParams,
  DEFAULT_GA_MEASUREMENT_ID,
  formOutcomeEvent,
  getAnalyticsBootScript,
  gtagScriptSrc,
  isOutboundHref,
  linkDomain,
  purchaseEvent,
  resolveAnalyticsConfig,
  sanitizeParams,
  setAnalyticsUser,
  toAnalyticsValue,
  trackEvent,
  truncateParam,
} from "./analytics";
import type { ChapterRecord, PaymentRecord, SiteContext } from "./types";

describe("resolveAnalyticsConfig", () => {
  it("enables the default measurement ID only for production deploys", () => {
    expect(resolveAnalyticsConfig({ NODE_ENV: "production" })).toEqual({
      measurementId: DEFAULT_GA_MEASUREMENT_ID,
      enabled: true,
      debugMode: false,
    });
    expect(
      resolveAnalyticsConfig({ NODE_ENV: "production", NEXT_PUBLIC_VERCEL_ENV: "production" })
        .enabled,
    ).toBe(true);
  });

  it("stays off in development, tests, and Vercel previews", () => {
    expect(resolveAnalyticsConfig({ NODE_ENV: "development" }).enabled).toBe(false);
    expect(resolveAnalyticsConfig({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(
      resolveAnalyticsConfig({ NODE_ENV: "production", NEXT_PUBLIC_VERCEL_ENV: "preview" }).enabled,
    ).toBe(false);
  });

  it("honours an override ID, the off switch, and debug mode", () => {
    expect(
      resolveAnalyticsConfig({ NODE_ENV: "production", NEXT_PUBLIC_GA_MEASUREMENT_ID: " G-ABCDEF1 " }),
    ).toMatchObject({ measurementId: "G-ABCDEF1", enabled: true });
    expect(
      resolveAnalyticsConfig({ NODE_ENV: "production", NEXT_PUBLIC_GA_MEASUREMENT_ID: "off" }).enabled,
    ).toBe(false);
    expect(
      resolveAnalyticsConfig({ NODE_ENV: "production", NEXT_PUBLIC_GA_MEASUREMENT_ID: "UA-1234" })
        .enabled,
    ).toBe(false);
    expect(resolveAnalyticsConfig({ NODE_ENV: "development", NEXT_PUBLIC_GA_DEBUG: "1" })).toEqual({
      measurementId: DEFAULT_GA_MEASUREMENT_ID,
      enabled: true,
      debugMode: true,
    });
  });
});

describe("boot script", () => {
  const globalSite: SiteContext = { isGlobal: true, tenant: null, host: "wial.org" };

  it("installs the gtag stub, user properties, and config with site dimensions", () => {
    const script = getAnalyticsBootScript(
      { measurementId: "G-TEST1234", enabled: true, debugMode: false },
      { siteTenant: "global", userRole: null },
    );

    expect(script).toContain("window.dataLayer=window.dataLayer||[];");
    expect(script).toContain("function gtag(){dataLayer.push(arguments);}");
    expect(script).toContain("window.gtag=gtag;");
    expect(script).toContain(
      `gtag('set','user_properties',{"user_role":"anonymous","site_tenant":"global"});`,
    );
    expect(script).toContain(
      `gtag('config',"G-TEST1234",{"site_tenant":"global","user_role":"anonymous"});`,
    );
    expect(script).not.toContain("debug_mode");
    expect(script).not.toContain("__wialAnalyticsDebug");
  });

  it("tags admins as internal traffic and adds debug_mode when requested", () => {
    const script = getAnalyticsBootScript(
      { measurementId: "G-TEST1234", enabled: true, debugMode: true },
      { siteTenant: "usa", userRole: "platform_admin" },
    );

    expect(script).toContain('"traffic_type":"internal"');
    expect(script).toContain('"debug_mode":true');
    expect(script).toContain("window.__wialAnalyticsDebug=true;");
    expect(script).toContain('"site_tenant":"usa"');
  });

  it("escapes < so the inline script cannot be closed early", () => {
    const script = getAnalyticsBootScript(
      { measurementId: "G-TEST1234", enabled: true, debugMode: false },
      { siteTenant: "</script><script>alert(1)", userRole: null },
    );
    expect(script).not.toContain("</script>");
    expect(script).toContain("\\u003c/script>");
  });

  it("derives the tenant dimension and gtag URL", () => {
    expect(analyticsSiteTenant(globalSite)).toBe("global");
    expect(
      analyticsSiteTenant({
        isGlobal: false,
        host: "usa.wial.org",
        tenant: { subdomain: "usa" } as unknown as ChapterRecord,
      }),
    ).toBe("usa");
    expect(gtagScriptSrc("G-TEST1234")).toBe(
      "https://www.googletagmanager.com/gtag/js?id=G-TEST1234",
    );
  });

  it("only marks admin roles as internal traffic", () => {
    expect(analyticsTrafficType("platform_admin")).toBe("internal");
    expect(analyticsTrafficType("chapter_admin")).toBe("internal");
    expect(analyticsTrafficType("coach")).toBeNull();
    expect(analyticsTrafficType(null)).toBeNull();
    expect(buildGlobalParams({ siteTenant: "global", userRole: "coach" })).toEqual({
      site_tenant: "global",
      user_role: "coach",
    });
  });
});

describe("param hygiene", () => {
  it("clamps strings to 100 characters and collapses whitespace", () => {
    expect(truncateParam("  hello   world  ")).toBe("hello world");
    expect(truncateParam("x".repeat(150))).toHaveLength(100);
  });

  it("drops undefined and empty values but keeps numbers, booleans, and item arrays", () => {
    expect(
      sanitizeParams({
        a: undefined,
        b: "",
        c: "   ",
        d: "ok",
        e: 0,
        f: false,
        items: [{ item_id: "x", item_name: "X", price: 1, quantity: 1 }],
      }),
    ).toEqual({
      d: "ok",
      e: 0,
      f: false,
      items: [{ item_id: "x", item_name: "X", price: 1, quantity: 1 }],
    });
  });

  it("classifies outbound links", () => {
    expect(linkDomain("https://directory.wial.org/coaches")).toBe("directory.wial.org");
    expect(linkDomain("/coaches")).toBeNull();
    expect(linkDomain("mailto:info@wial.org")).toBeNull();
    expect(isOutboundHref("http://example.com")).toBe(true);
    expect(isOutboundHref("#badges")).toBe(false);
  });
});

describe("commerce events", () => {
  it("converts Stripe minor units to GA values", () => {
    expect(toAnalyticsValue(12345, "usd")).toBe(123.45);
    expect(toAnalyticsValue(5000, "JPY")).toBe(5000);
  });

  it("builds begin_checkout for a payment type", () => {
    expect(
      beginCheckoutEvent({
        priceId: "price_1",
        productId: "prod_1",
        name: "Annual dues",
        nickname: "Dues",
        description: null,
        amount: 15000,
        currency: "usd",
      }),
    ).toEqual({
      name: "begin_checkout",
      params: {
        checkout_type: "payment",
        currency: "USD",
        value: 150,
        items: [
          {
            item_id: "price_1",
            item_name: "Annual dues",
            item_category: "Dues",
            price: 150,
            quantity: 1,
          },
        ],
      },
    });
  });

  it("builds begin_checkout for a donation", () => {
    const event = beginDonationEvent(2500);
    expect(event.name).toBe("begin_checkout");
    expect(event.params).toMatchObject({ checkout_type: "donation", currency: "USD", value: 25 });
  });

  it("builds purchase with the Stripe session as transaction_id", () => {
    const payment: PaymentRecord = {
      id: "1",
      stripeSessionId: "cs_test_123",
      productName: "Better World Fund donation",
      amount: 5000,
      currency: "usd",
      payerEmail: "donor@example.com",
      payerName: null,
      userId: null,
      status: "paid",
      paidAt: null,
      source: "better-world-donation",
    };
    const event = purchaseEvent(payment);
    expect(event.name).toBe("purchase");
    expect(event.params).toMatchObject({
      checkout_type: "donation",
      transaction_id: "cs_test_123",
      currency: "USD",
      value: 50,
    });
    // Never leak the payer's email into analytics.
    expect(JSON.stringify(event)).not.toContain("donor@example.com");
  });
});

describe("form outcomes", () => {
  it("maps success to generate_lead with context and failure to form_error", () => {
    expect(formOutcomeEvent("contact", { success: true }, { form_topic: "Certification" })).toEqual({
      name: "generate_lead",
      params: { form_name: "contact", form_topic: "Certification" },
    });
    expect(formOutcomeEvent("contact", { error: "Name is required" })).toEqual({
      name: "form_error",
      params: { form_name: "contact", error_message: "Name is required" },
    });
    expect(formOutcomeEvent("contact", null)).toEqual({
      name: "form_error",
      params: { form_name: "contact", error_message: "unexpected" },
    });
  });
});

describe("newsletter form outcome", () => {
  it("fires generate_lead on success and form_error on failure without the email", () => {
    expect(
      formOutcomeEvent("newsletter", { success: true }, { form_topic: "footer" }),
    ).toEqual({
      name: "generate_lead",
      params: { form_name: "newsletter", form_topic: "footer" },
    });
    expect(
      formOutcomeEvent("newsletter", { error: "Please enter a valid email address." }),
    ).toEqual({
      name: "form_error",
      params: {
        form_name: "newsletter",
        error_message: "Please enter a valid email address.",
      },
    });
  });
});

describe("client runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op when gtag is not installed", () => {
    vi.stubGlobal("window", {});
    expect(() => trackEvent({ name: "chatbot_open", params: {} })).not.toThrow();
  });

  it("forwards sanitized events and user updates to gtag", () => {
    const gtag = vi.fn();
    vi.stubGlobal("window", { gtag });

    trackEvent({
      name: "cta_click",
      params: { cta_label: "  Contact WIAL ", cta_location: "hero", cta_destination: "/contact" },
    });
    expect(gtag).toHaveBeenCalledWith("event", "cta_click", {
      cta_label: "Contact WIAL",
      cta_location: "hero",
      cta_destination: "/contact",
    });

    setAnalyticsUser({ siteTenant: "global", userRole: "coach" });
    expect(gtag).toHaveBeenCalledWith("set", { site_tenant: "global", user_role: "coach" });
    expect(gtag).toHaveBeenCalledWith("set", "user_properties", {
      user_role: "coach",
      site_tenant: "global",
    });
  });
});
