"use server";

import { headers } from "next/headers";
import { getConstantContactProvider } from "@/lib/constant-contact";
import {
  clientKeyFromHeaders,
  createRateLimiter,
  isNewsletterSource,
  NEWSLETTER_MESSAGES,
  subscribeToNewsletter,
  type NewsletterResult,
} from "@/lib/newsletter";
import { createNewsletterStore } from "@/lib/newsletter-store";

// 5 attempts per minute per client, in memory (per server instance).
const limiter = createRateLimiter(5, 60_000);
// Requests with no usable proxy header share one bucket, so keep it lenient.
const unknownLimiter = createRateLimiter(120, 60_000);

/** Shared by every inline newsletter form (home, footer, resources, thank-you states). */
export async function subscribeNewsletterAction(
  formData: FormData,
): Promise<NewsletterResult> {
  // Honeypot: bots fill the hidden field. Pretend success, do nothing.
  if (String(formData.get("website") ?? "").trim()) {
    return { success: true, status: "subscribed", message: NEWSLETTER_MESSAGES.subscribed };
  }

  const source = formData.get("source");
  if (!isNewsletterSource(source)) {
    return { error: NEWSLETTER_MESSAGES.unavailable };
  }

  const headerStore = await headers();
  const clientKey = clientKeyFromHeaders((name) => headerStore.get(name));
  const allowed = clientKey
    ? limiter.allow(clientKey)
    : unknownLimiter.allow("unknown");
  if (!allowed) {
    return { error: NEWSLETTER_MESSAGES.tooMany };
  }

  const siteTenant = headerStore.get("x-wial-tenant")?.slice(0, 63) || null;

  try {
    return await subscribeToNewsletter(
      { email: formData.get("email"), source, siteTenant },
      { provider: getConstantContactProvider(), store: createNewsletterStore() },
    );
  } catch {
    console.error("Newsletter sign-up failed unexpectedly");
    return { error: NEWSLETTER_MESSAGES.unavailable };
  }
}
