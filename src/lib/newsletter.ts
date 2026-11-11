/**
 * Newsletter sign-up core (#164): validation, outcome mapping and the
 * consent copy. Pure and dependency-injected so it can be unit tested;
 * the server action wires the real provider (Constant Contact) and store.
 */

export const NEWSLETTER_HEADING = "Join our newsletter";
export const NEWSLETTER_COPY =
  "Get Action Learning insights, events and certification dates.";
/** Bump when the consent copy changes; stored as a prefix of `consent_text`. */
export const NEWSLETTER_CONSENT_VERSION = "v1";
export const NEWSLETTER_CONSENT_TEXT =
  "By subscribing you agree to receive WIAL emails. You can unsubscribe at any time.";

/** Where a sign-up form is mounted. `become-a-coach-thank-you` is reserved for #161. */
export const NEWSLETTER_SOURCES = [
  "home",
  "footer",
  "resources",
  "become-a-coach-thank-you",
  "affiliate-inquiry-thank-you",
] as const;
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];

export function isNewsletterSource(value: unknown): value is NewsletterSource {
  return (
    typeof value === "string" &&
    (NEWSLETTER_SOURCES as readonly string[]).includes(value)
  );
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/** Trimmed, lower-cased address, or null when it is not a plausible email. */
export function normalizeNewsletterEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

export const NEWSLETTER_MESSAGES = {
  invalidEmail: "Please enter a valid email address.",
  subscribed: "Thanks, you are subscribed. Watch your inbox for WIAL news.",
  saved:
    "We have saved your email but could not complete the sign-up yet, so you are not on the newsletter list. Please try again later.",
  rejected: "That email address was not accepted. Please check it and try again.",
  unavailable: "We could not sign you up right now. Please try again later.",
  tooMany: "Too many attempts. Please wait a minute and try again.",
} as const;

export type NewsletterResult = {
  success?: boolean;
  /** `subscribed`: the list accepted the address. `saved`: stored, not yet on the list. */
  status?: "subscribed" | "saved";
  message?: string;
  error?: string;
  /** Marks an error that belongs to the email field. */
  fieldError?: boolean;
};

export type ProviderResult =
  | { kind: "ok" }
  | { kind: "rejected"; code: string }
  | { kind: "unavailable"; code: string }
  | { kind: "unconfigured" };

export type NewsletterProvider = {
  subscribe(email: string): Promise<ProviderResult>;
};

export type NewsletterRecord = {
  email: string;
  source: NewsletterSource;
  siteTenant: string | null;
  consentText: string;
  status: "pending" | "subscribed" | "failed";
  providerError: string | null;
};

export type NewsletterStore = {
  /** Insert or update the row. Returns false when nothing was persisted. */
  save(record: NewsletterRecord): Promise<boolean>;
};

export type SubscribeInput = {
  email: unknown;
  source: NewsletterSource;
  siteTenant: string | null;
};

export async function subscribeToNewsletter(
  input: SubscribeInput,
  deps: { provider: NewsletterProvider; store: NewsletterStore | null },
): Promise<NewsletterResult> {
  const email = normalizeNewsletterEmail(input.email);
  if (!email) {
    return {
      error: NEWSLETTER_MESSAGES.invalidEmail,
      fieldError: true,
    };
  }

  const { provider, store } = deps;

  // Always ask the provider: its sign-up call is idempotent, and a local
  // "subscribed" row can be stale (unsubscribed, cleaned or deleted contact).
  const base = {
    email,
    source: input.source,
    siteTenant: input.siteTenant,
    consentText: `${NEWSLETTER_CONSENT_VERSION}: ${NEWSLETTER_CONSENT_TEXT}`,
  };

  let result: ProviderResult;
  try {
    result = await provider.subscribe(email);
  } catch {
    result = { kind: "unavailable", code: "exception" };
  }

  if (result.kind === "ok") {
    // The provider is the source of truth; the local row is a best-effort record.
    await store?.save({ ...base, status: "subscribed", providerError: null });
    return {
      success: true,
      status: "subscribed",
      message: NEWSLETTER_MESSAGES.subscribed,
    };
  }

  if (result.kind === "rejected") {
    await store?.save({ ...base, status: "failed", providerError: result.code });
    return {
      error: NEWSLETTER_MESSAGES.rejected,
      fieldError: true,
    };
  }

  // Unconfigured or unreachable: keep the address as a record and say so
  // honestly. Never claim "subscribed" or promise a later add (no backfill job).
  const saved = store
    ? await store.save({
        ...base,
        status: "pending",
        providerError:
          result.kind === "unconfigured" ? "unconfigured" : result.code,
      })
    : false;
  if (saved) {
    return {
      success: true,
      status: "saved",
      message: NEWSLETTER_MESSAGES.saved,
    };
  }
  return { error: NEWSLETTER_MESSAGES.unavailable };
}

/** The off-site Constant Contact CTA that #164 replaced (stale DB copies may still carry it). */
export function isLegacyNewsletterSection(section: {
  type?: unknown;
  href?: unknown;
}): boolean {
  return (
    section.type === "cta" &&
    typeof section.href === "string" &&
    section.href.includes("constantcontact.com")
  );
}

/** Client IP from the proxy-appended (last) x-forwarded-for hop, else x-real-ip. */
export function clientKeyFromHeaders(get: (name: string) => string | null): string | null {
  const hops = (get("x-forwarded-for") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return hops.at(-1) || get("x-real-ip")?.trim() || null;
}

/** Small in-memory sliding-window limiter to protect the provider quota. */
export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now: number = Date.now()): boolean {
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      if (hits.size > 5000) {
        for (const [k, v] of hits) {
          if (v.every((t) => now - t >= windowMs)) hits.delete(k);
        }
      }
      return true;
    },
  };
}
