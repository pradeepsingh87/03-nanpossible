import { createServiceRoleSupabaseClient } from "@/lib/supabase-admin";
import type { NewsletterRecord, NewsletterStore } from "@/lib/newsletter";

/**
 * Service-role store for `newsletter_signups` (no anon policy by design).
 * Returns null when the service-role key is not configured.
 */
export function createNewsletterStore(): NewsletterStore | null {
  const supabase = createServiceRoleSupabaseClient();
  if (!supabase) return null;

  return {
    async save(record: NewsletterRecord) {
      try {
        const now = new Date().toISOString();
        const subscribedAt = record.status === "subscribed" ? now : null;
        const refresh = {
          status: record.status,
          provider_error: record.providerError,
          source: record.source,
          site_tenant: record.siteTenant,
          consent_text: record.consentText,
          updated_at: now,
          ...(subscribedAt ? { subscribed_at: subscribedAt } : {}),
        };

        const { error } = await supabase.from("newsletter_signups").insert({
          email: record.email,
          source: record.source,
          site_tenant: record.siteTenant,
          consent_text: record.consentText,
          status: record.status,
          provider_error: record.providerError,
          subscribed_at: subscribedAt,
        });
        if (!error) return true;
        if (error.code !== "23505") {
          console.error("Newsletter store insert failed:", error.code ?? "unknown");
          return false;
        }

        // Row exists (earlier or concurrent sign-up): refresh it and bump attempts.
        const { data: existing } = await supabase
          .from("newsletter_signups")
          .select("attempts")
          .eq("email", record.email)
          .maybeSingle();
        const attempts = ((existing as { attempts?: number } | null)?.attempts ?? 1) + 1;
        const { error: updateError } = await supabase
          .from("newsletter_signups")
          .update({ ...refresh, attempts })
          .eq("email", record.email);
        if (updateError) {
          console.error("Newsletter store update failed:", updateError.code ?? "unknown");
          return false;
        }
        return true;
      } catch {
        console.error("Newsletter store failed");
        return false;
      }
    },
  };
}
