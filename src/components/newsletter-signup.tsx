"use client";

import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import { subscribeNewsletterAction } from "@/app/actions/newsletter";
import { formOutcomeEvent, trackEvent } from "@/lib/analytics";
import {
  NEWSLETTER_CONSENT_TEXT,
  NEWSLETTER_COPY,
  NEWSLETTER_HEADING,
  NEWSLETTER_MESSAGES,
  normalizeNewsletterEmail,
  type NewsletterResult,
  type NewsletterSource,
} from "@/lib/newsletter";

type NewsletterSignupProps = {
  source: NewsletterSource;
  /** card: standalone panel (home, /resources); footer: inside the footer panel; compact: thank-you states. */
  variant?: "card" | "footer" | "compact";
  heading?: string;
  copy?: string;
};

/**
 * Inline newsletter capture. Stays on the page (server action, no redirect).
 * Drop it into any success state, e.g. the /become-a-coach thank-you (#161):
 *   <NewsletterSignup source="become-a-coach-thank-you" variant="compact" />
 */
export function NewsletterSignup({
  source,
  variant = "card",
  heading = NEWSLETTER_HEADING,
  copy = NEWSLETTER_COPY,
}: NewsletterSignupProps) {
  const uid = useId();
  const inputId = `${uid}-email`;
  const headingId = `${uid}-heading`;
  const statusId = `${uid}-status`;
  const errorId = `${uid}-error`;
  const consentId = `${uid}-consent`;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<NewsletterResult | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isSubmitting) return;
    const form = event.currentTarget;
    const formData = new FormData(form);

    if (!normalizeNewsletterEmail(formData.get("email"))) {
      const invalid = { error: NEWSLETTER_MESSAGES.invalidEmail, fieldError: true };
      setResult(invalid);
      trackEvent(formOutcomeEvent("newsletter", invalid, { form_topic: source }));
      return;
    }

    setIsSubmitting(true);
    setResult(null);
    formData.set("source", source);

    try {
      const response = await subscribeNewsletterAction(formData);
      setResult(response);
      // "saved" means the address never reached the list: not a lead.
      const tracked =
        response.status === "saved"
          ? { error: "saved_not_synced" }
          : response;
      trackEvent(formOutcomeEvent("newsletter", tracked, { form_topic: source }));
      if (response.status === "subscribed") form.reset();
    } catch {
      const failure = { error: NEWSLETTER_MESSAGES.unavailable };
      setResult(failure);
      trackEvent(formOutcomeEvent("newsletter", failure, { form_topic: source }));
    } finally {
      setIsSubmitting(false);
    }
  }

  const isCard = variant === "card";
  const HeadingTag = "h2";
  const regionLabel =
    variant === "footer" ? "Newsletter sign-up, footer" : undefined;
  const wrapperClass = isCard
    ? "site-panel rounded-[2rem] px-6 py-6 md:px-8"
    : variant === "footer"
      ? "border-b border-[rgba(23,53,51,0.12)] pb-6"
      : "mt-6 rounded-[1.5rem] border border-[rgba(23,53,51,0.12)] px-5 py-5";
  const headingClass = isCard
    ? "font-display text-3xl leading-none tracking-[-0.04em] text-teal-deep"
    : "font-display text-2xl leading-none tracking-[-0.03em] text-teal-deep";

  return (
    <section
      aria-label={regionLabel}
      aria-labelledby={regionLabel ? undefined : headingId}
      className={wrapperClass}
      data-newsletter-source={source}
    >
      <div className="grid gap-4 md:grid-cols-[1fr_1.2fr] md:items-start md:gap-8">
        <div className="space-y-2">
          <HeadingTag className={headingClass} id={headingId}>
            {heading}
          </HeadingTag>
          <p className="text-base leading-7 text-foreground/78">{copy}</p>
        </div>

        <form className="grid gap-3" noValidate onSubmit={handleSubmit}>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <div className="field-shell">
              <label className="field-label" htmlFor={inputId}>
                Email address
              </label>
              <input
                aria-describedby={`${consentId} ${errorId}`}
                aria-invalid={result?.fieldError ? true : undefined}
                autoComplete="email"
                className="field-input newsletter-field"
                onChange={() =>
                  setResult((prev) => (prev?.fieldError ? null : prev))
                }
                id={inputId}
                inputMode="email"
                name="email"
                placeholder="you@example.com"
                required
                type="email"
              />
            </div>
            {/* Honeypot: hidden from people and assistive tech, bots fill it. */}
            <div aria-hidden="true" className="sr-only">
              <input autoComplete="off" name="website" tabIndex={-1} type="text" />
            </div>
            <button
              className="button-link primary newsletter-button w-full justify-center sm:w-auto"
              disabled={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Subscribing..." : "Subscribe"}
            </button>
          </div>

          <p className="text-sm leading-6 text-foreground/62" id={consentId}>
            {NEWSLETTER_CONSENT_TEXT}{" "}
            <Link className="-my-3 inline-block py-3 font-semibold text-accent underline" href="/privacy">
              Read our Privacy Policy
            </Link>
            .
          </p>

          {/* "saved" means the address is NOT on the list yet, so it is announced assertively like an error. */}
          <div id={statusId} role="status">
            {result?.success && result.status !== "saved" ? (
              <div className="account-flash is-success">{result.message}</div>
            ) : null}
          </div>
          <div id={errorId} role="alert">
            {result?.error || result?.status === "saved" ? (
              <div className="account-flash is-error">
                {result.error ?? result.message}
              </div>
            ) : null}
          </div>
        </form>
      </div>
    </section>
  );
}
