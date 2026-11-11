/**
 * Google Analytics 4 instrumentation.
 *
 * - `resolveAnalyticsConfig` decides whether GA loads (production only unless
 *   `NEXT_PUBLIC_GA_DEBUG=1`) and which measurement ID to use.
 * - `getAnalyticsBootScript` renders the gtag stub + `config` call that the
 *   root layout inlines in `<head>` so `window.gtag` exists before hydration.
 * - `trackEvent` is the single client-side entry point. It is a typed union of
 *   every event the site sends, so param names stay consistent across pages
 *   (GA4 custom dimensions are registered per param name).
 *
 * Page views are GA's own: the initial `config` call sends one and Enhanced
 * measurement ("Page changes based on browser history events") covers App
 * Router client navigations. Do not send `page_view` manually or they double.
 *
 * Never send personal data (names, emails, free-text messages) in params.
 */

import type { AppRole, PaymentRecord, PaymentType, SiteContext } from "@/lib/types";

export const DEFAULT_GA_MEASUREMENT_ID = "G-3W999NPQJY";

const MEASUREMENT_ID_PATTERN = /^G-[A-Z0-9]{4,}$/;

/** GA4 caps event parameter values at 100 characters. */
export const GA_PARAM_MAX_LENGTH = 100;

export type AnalyticsEnv = {
  NODE_ENV?: string;
  NEXT_PUBLIC_GA_MEASUREMENT_ID?: string;
  NEXT_PUBLIC_GA_DEBUG?: string;
  NEXT_PUBLIC_VERCEL_ENV?: string;
};

export type AnalyticsConfig = {
  measurementId: string;
  /** Load gtag.js and send hits. False in development, previews, and tests. */
  enabled: boolean;
  /** Tag every hit with `debug_mode` so it shows in GA's DebugView. */
  debugMode: boolean;
};

export function resolveAnalyticsConfig(env: AnalyticsEnv): AnalyticsConfig {
  const raw = env.NEXT_PUBLIC_GA_MEASUREMENT_ID?.trim();
  const measurementId = raw ? raw : DEFAULT_GA_MEASUREMENT_ID;
  const debugMode = env.NEXT_PUBLIC_GA_DEBUG === "1" || env.NEXT_PUBLIC_GA_DEBUG === "true";

  if (raw?.toLowerCase() === "off" || !MEASUREMENT_ID_PATTERN.test(measurementId)) {
    return { measurementId, enabled: false, debugMode };
  }

  const vercelEnv = env.NEXT_PUBLIC_VERCEL_ENV;
  const isProductionDeploy =
    env.NODE_ENV === "production" && (vercelEnv === undefined || vercelEnv === "production");

  return { measurementId, enabled: debugMode || isProductionDeploy, debugMode };
}

/** Value of the `site_tenant` dimension: `global` on wial.org, else the affiliate subdomain. */
export function analyticsSiteTenant(siteContext: SiteContext): string {
  return siteContext.isGlobal ? "global" : siteContext.tenant.subdomain;
}

/**
 * GA4's built-in "Internal traffic" data filter drops events whose
 * `traffic_type` is `internal`; admins get that tag so their clicks can be
 * excluded from reports once the filter is switched from Testing to Active.
 */
export function analyticsTrafficType(role: AppRole | null): "internal" | null {
  return role === "platform_admin" || role === "chapter_admin" ? "internal" : null;
}

export type AnalyticsUserContext = {
  siteTenant: string;
  userRole: AppRole | null;
};

/** Params attached to every event (`gtag('set', ...)`) plus user-scoped properties. */
export function buildGlobalParams({ siteTenant, userRole }: AnalyticsUserContext) {
  const params: Record<string, string> = {
    site_tenant: siteTenant,
    user_role: userRole ?? "anonymous",
  };
  const trafficType = analyticsTrafficType(userRole);
  if (trafficType) {
    params.traffic_type = trafficType;
  }
  return params;
}

export function buildUserProperties({ siteTenant, userRole }: AnalyticsUserContext) {
  return {
    user_role: userRole ?? "anonymous",
    site_tenant: siteTenant,
  };
}

function inlineJson(value: unknown) {
  // `<` cannot appear literally inside an inline <script>.
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function getAnalyticsBootScript(
  config: AnalyticsConfig,
  user: AnalyticsUserContext,
): string {
  const configParams: Record<string, unknown> = {
    ...buildGlobalParams(user),
    ...(config.debugMode ? { debug_mode: true } : {}),
  };

  return [
    "window.dataLayer=window.dataLayer||[];",
    "function gtag(){dataLayer.push(arguments);}",
    "window.gtag=gtag;",
    config.debugMode ? "window.__wialAnalyticsDebug=true;" : "",
    "gtag('js',new Date());",
    `gtag('set','user_properties',${inlineJson(buildUserProperties(user))});`,
    `gtag('config',${inlineJson(config.measurementId)},${inlineJson(configParams)});`,
  ]
    .filter(Boolean)
    .join("");
}

export function gtagScriptSrc(measurementId: string) {
  return `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
}

// ---------------------------------------------------------------------------
// Event taxonomy
// ---------------------------------------------------------------------------

export type CtaLocation =
  | "hero"
  | "cta_section"
  | "feature_grid"
  | "contact_cards"
  | "resource_list"
  | "header"
  | "mobile_drawer"
  | "footer"
  | "coaches_band"
  | "certification"
  | "pay"
  | "pay_success"
  | "donate"
  | "network_map"
  | "partner_pricing"
  | "tenant_home"
  | "contact_page";

export type ContentType =
  | "coach_profile"
  | "library_item"
  | "library_filter"
  | "certification_level"
  | "affiliate_site"
  | "partner_logo"
  | "partner_pricing_band";

export type SearchType = "coach" | "library" | "wial_talk";

export type FormName =
  | "contact"
  | "affiliate_inquiry"
  | "partner_application"
  | "success_story"
  | "better_world_application"
  | "award_nomination"
  | "newsletter";

export type CheckoutType = "payment" | "donation";

export type CoachContactMethod =
  | "email"
  | "phone"
  | "website"
  | "linkedin"
  | "social"
  | "cv"
  | "credly"
  | "affiliate";

export type AnalyticsItem = {
  item_id: string;
  item_name: string;
  price: number;
  quantity: number;
  item_category?: string;
};

type Scalar = string | number | boolean;

export type AnalyticsEvent =
  // Navigation and calls to action -----------------------------------------
  | {
      name: "cta_click";
      params: {
        cta_label: string;
        cta_location: CtaLocation;
        cta_destination: string;
        outbound?: boolean;
      };
    }
  | {
      name: "nav_click";
      params: {
        nav_label: string;
        nav_location: "header" | "mobile_drawer" | "footer";
        nav_destination: string;
        outbound?: boolean;
      };
    }
  | {
      name: "select_content";
      params: {
        content_type: ContentType;
        content_id: string;
        item_kind?: string;
        outbound?: boolean;
      };
    }
  | {
      name: "load_more";
      params: { list_name: SearchType; shown_count: number };
    }
  // Search -------------------------------------------------------------------
  | {
      name: "search";
      params: {
        search_type: SearchType;
        search_term?: string;
        result_count: number;
        search_mode?: string;
        cert_level?: string;
        country?: string;
        language?: string;
        library_filter?: string;
      };
    }
  // Forms (GA4 recommended `generate_lead` on success) -----------------------
  | {
      name: "generate_lead";
      params: {
        form_name: FormName;
        form_topic?: string;
        form_variant?: string;
      };
    }
  | {
      name: "form_error";
      params: { form_name: FormName; error_message: string };
    }
  // Payments (GA4 ecommerce) -------------------------------------------------
  | {
      name: "begin_checkout";
      params: {
        checkout_type: CheckoutType;
        currency: string;
        value: number;
        items: AnalyticsItem[];
      };
    }
  | {
      name: "purchase";
      params: {
        checkout_type: CheckoutType;
        transaction_id: string;
        currency: string;
        value: number;
        items: AnalyticsItem[];
      };
    }
  | { name: "checkout_cancel"; params: { checkout_type: CheckoutType } }
  | {
      name: "checkout_error";
      params: { checkout_type: CheckoutType; error_code: string };
    }
  // Accounts -----------------------------------------------------------------
  | { name: "sign_up"; params: { method: "password" } }
  | { name: "sign_up_error"; params: { error_code: string } }
  | { name: "login"; params: { method: "password" } }
  | { name: "login_error"; params: { error_code: string } }
  | { name: "logout"; params: Record<string, never> }
  | {
      name: "coach_registration";
      params: {
        status: "submitted" | "profile_linked" | "error";
        error_code?: string;
      };
    }
  // Coach directory ----------------------------------------------------------
  | {
      name: "coach_contact_click";
      params: { contact_method: CoachContactMethod; coach_slug: string };
    }
  // Chatbot ------------------------------------------------------------------
  | { name: "chatbot_open"; params: Record<string, never> }
  | {
      name: "chatbot_message";
      params: {
        prompt_source: "starter" | "typed";
        prompt_label?: string;
        response_status: "ok" | "error";
      };
    };

export type AnalyticsEventName = AnalyticsEvent["name"];

/** Truncate a param value to GA's 100-character limit, trimming whitespace. */
export function truncateParam(value: string, max = GA_PARAM_MAX_LENGTH): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Drop undefined/empty params and clamp string lengths; arrays (items) pass through. */
export function sanitizeParams(
  params: Record<string, Scalar | AnalyticsItem[] | undefined>,
): Record<string, Scalar | AnalyticsItem[]> {
  const output: Record<string, Scalar | AnalyticsItem[]> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      const clean = truncateParam(value);
      if (clean) {
        output[key] = clean;
      }
      continue;
    }
    output[key] = value;
  }
  return output;
}

/** Hostname of an absolute URL, or null for relative/mailto/tel links. */
export function linkDomain(href: string): string | null {
  try {
    const url = new URL(href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname : null;
  } catch {
    return null;
  }
}

export function isOutboundHref(href: string): boolean {
  return linkDomain(href) !== null;
}

/** Stripe stores minor units; GA wants major-unit decimals (except zero-decimal currencies). */
export function toAnalyticsValue(amountMinor: number, currency: string): number {
  const zeroDecimal = new Set(["bif", "clp", "djf", "gnf", "jpy", "kmf", "krw", "mga", "pyg", "rwf", "ugx", "vnd", "vuv", "xaf", "xof", "xpf"]);
  if (zeroDecimal.has(currency.toLowerCase())) {
    return amountMinor;
  }
  return Math.round(amountMinor) / 100;
}

export function beginCheckoutEvent(paymentType: PaymentType): AnalyticsEvent {
  const value = toAnalyticsValue(paymentType.amount, paymentType.currency);
  return {
    name: "begin_checkout",
    params: {
      checkout_type: "payment",
      currency: paymentType.currency.toUpperCase(),
      value,
      items: [
        {
          item_id: paymentType.priceId,
          item_name: paymentType.name,
          item_category: paymentType.nickname ?? "One-time payment",
          price: value,
          quantity: 1,
        },
      ],
    },
  };
}

export const DONATION_ITEM_ID = "better-world-donation";

export function beginDonationEvent(amountMinor: number, currency = "usd"): AnalyticsEvent {
  const value = toAnalyticsValue(amountMinor, currency);
  return {
    name: "begin_checkout",
    params: {
      checkout_type: "donation",
      currency: currency.toUpperCase(),
      value,
      items: [
        {
          item_id: DONATION_ITEM_ID,
          item_name: "Better World Fund donation",
          item_category: "Donation",
          price: value,
          quantity: 1,
        },
      ],
    },
  };
}

export function purchaseEvent(payment: PaymentRecord): AnalyticsEvent {
  const isDonation = payment.source === "better-world-donation";
  const value = toAnalyticsValue(payment.amount, payment.currency);
  return {
    name: "purchase",
    params: {
      checkout_type: isDonation ? "donation" : "payment",
      transaction_id: payment.stripeSessionId,
      currency: payment.currency.toUpperCase(),
      value,
      items: [
        {
          item_id: isDonation ? DONATION_ITEM_ID : payment.productName,
          item_name: payment.productName,
          item_category: isDonation ? "Donation" : "One-time payment",
          price: value,
          quantity: 1,
        },
      ],
    },
  };
}

/** Success → `generate_lead`, failure → `form_error`; shared by every public form. */
export function formOutcomeEvent(
  formName: FormName,
  result: { success?: boolean; error?: string } | null | undefined,
  extras: { form_topic?: string; form_variant?: string } = {},
): AnalyticsEvent {
  if (result?.success) {
    return { name: "generate_lead", params: { form_name: formName, ...extras } };
  }
  return {
    name: "form_error",
    params: { form_name: formName, error_message: result?.error ?? "unexpected" },
  };
}

// ---------------------------------------------------------------------------
// Client runtime
// ---------------------------------------------------------------------------

type GtagFunction = (...args: unknown[]) => void;

declare global {
  interface Window {
    gtag?: GtagFunction;
    dataLayer?: unknown[];
    __wialAnalyticsDebug?: boolean;
  }
}

function getGtag(): GtagFunction | null {
  if (typeof window === "undefined") {
    return null;
  }
  return typeof window.gtag === "function" ? window.gtag : null;
}

/**
 * Send one event. A no-op when analytics is disabled for this environment
 * (the boot script never ran, so `window.gtag` is undefined).
 */
export function trackEvent(event: AnalyticsEvent) {
  const gtag = getGtag();
  if (!gtag) {
    return;
  }
  const params = sanitizeParams(event.params as Record<string, Scalar | AnalyticsItem[] | undefined>);
  if (window.__wialAnalyticsDebug) {
    console.debug("[analytics]", event.name, params);
  }
  gtag("event", event.name, params);
}

/** Re-tag the session after a sign-in/out without a full reload. */
export function setAnalyticsUser(user: AnalyticsUserContext) {
  const gtag = getGtag();
  if (!gtag) {
    return;
  }
  gtag("set", buildGlobalParams(user));
  gtag("set", "user_properties", buildUserProperties(user));
}
