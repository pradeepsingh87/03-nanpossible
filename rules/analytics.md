# Analytics (Google Analytics 4)

Property: `G-3W999NPQJY` (override with `NEXT_PUBLIC_GA_MEASUREMENT_ID`, disable with `off`).
GA loads only on production deploys. Run `NEXT_PUBLIC_GA_DEBUG=1 npm run dev` to load it
locally with `debug_mode` and watch events in **Admin → DebugView**; `trackEvent` also logs
to the browser console in that mode.

## How it is wired

- `src/lib/analytics.ts` — config, the typed `AnalyticsEvent` union, `trackEvent`, and the
  ecommerce/form helpers. Every event the site sends is declared here; add new ones to the
  union so param names stay consistent (GA custom dimensions are keyed by param name).
- `src/components/analytics/google-analytics.tsx` — rendered in `<head>` by the root layout:
  inline gtag stub + `config` (runs before hydration), gtag.js via `next/script`, and
  `AnalyticsSession`, which re-tags `user_role`/`site_tenant` after a sign-in without reload
  and emits `login`.
- `TrackedLink` — drop-in for `Link`/`<a>` that reports a click; safe in server components.
- `TrackEvent` — fires once on mount for server-rendered outcomes (receipts, notices, error
  banners); `dedupeKey` makes it once-per-browser-session.
- Page views are GA's own (initial `config` + Enhanced measurement "page changes based on
  browser history events" for App Router navigations). **Do not send `page_view` manually.**
- Enhanced measurement also auto-collects outbound `click`, `file_download`, `scroll`, and
  `form_start`/`form_submit`; our events add the *meaning* (which CTA, which form, did it
  succeed) rather than replacing those.

## Dimensions on every event

| Param | Values | Scope |
| --- | --- | --- |
| `site_tenant` | `global` or the affiliate subdomain (`usa`, `japan`, …) | event + user property |
| `user_role` | `anonymous`, `public_visitor`, `coach`, `content_creator`, `chapter_admin`, `platform_admin` | event + user property |
| `traffic_type` | `internal` for `platform_admin`/`chapter_admin` sessions | event |

Register `site_tenant` and `user_role` as custom dimensions (Admin → Custom definitions) so
they can be used in reports and explorations. Activate the built-in **Internal traffic**
data filter (Admin → Data filters, ships in *Testing* state) to drop admin sessions.

## Event dictionary

GA4 recommended events are used wherever one fits so the standard reports light up.

| Event | Fires when | Key params |
| --- | --- | --- |
| `generate_lead` ★ | Contact, affiliate inquiry, partner application, success story, Better World application, award nomination, or newsletter sign-up (`form_name: newsletter`, `form_topic` = placement such as `home`/`footer`/`resources`; the email is never sent) saved | `form_name`, `form_topic` (contact topic / industry / award category / org type), `form_variant` (nomination type, org type, affiliate type) |
| `form_error` | A form submit returned an error or threw | `form_name`, `error_message` |
| `sign_up` ★ | Public visitor registered (`/login?notice=registration-success\|confirm-email`) | `method` |
| `sign_up_error` | Registration redirected back with an error | `error_code` |
| `login` | Anonymous session became signed-in (root layout re-render) | `method` |
| `login_error` | Login page shows an error | `error_code` |
| `logout` | `/login?notice=signed-out` | — |
| `coach_registration` ★ | Coach profile submitted / linked / failed (`/account/register-coach`) | `status`, `error_code` |
| `begin_checkout` ★ | Pay button (`/pay`) or Donate button clicked; visitor leaves for Stripe | `checkout_type`, `currency`, `value`, `items[]` |
| `purchase` ★ | `/pay/success` verified the Stripe session (deduped per `transaction_id`) | `checkout_type`, `transaction_id`, `currency`, `value`, `items[]` |
| `checkout_cancel` | Returned from Stripe via the cancel URL | `checkout_type` |
| `checkout_error` | `/pay` or `/better-world/donate` shows an error banner | `checkout_type`, `error_code` |
| `search` | Coach search request completed; library / WIAL Talk search after typing pause | `search_type` (`coach`\|`library`\|`wial_talk`), `search_term`, `result_count`, `search_mode`, `cert_level`, `country`, `language`, `library_filter` |
| `select_content` | Coach card → profile, library item opened, library type filter, certification level expanded, affiliate chip, partner logo, partner fee band looked up | `content_type`, `content_id`, `item_kind`, `outbound` |
| `load_more` | "Load more"/"Show more" in a list | `list_name`, `shown_count` |
| `cta_click` | Any tracked button: hero Contact/Clients, `cta` sections, feature-grid links, certification CTAs, coaches band, header Sign in/Register, footer email, tenant official-site banner, Find a coach | `cta_label`, `cta_location`, `cta_destination`, `outbound` |
| `nav_click` | Header, mobile drawer, or footer navigation link | `nav_label`, `nav_location`, `nav_destination`, `outbound` |
| `coach_contact_click` | Email/phone/website/LinkedIn/social/CV/Credly/affiliate link on a coach profile or card | `contact_method`, `coach_slug` |
| `chatbot_open` | "Ask WIAL" panel opened | — |
| `chatbot_message` | Assistant answered or failed | `prompt_source` (`starter`\|`typed`), `prompt_label` (starter chips only), `response_status` |

★ = mark as a **Key event** in GA (Admin → Events) so they appear as conversions.

Recommended custom dimensions (event scope): `cta_label`, `cta_location`, `cta_destination`,
`nav_label`, `nav_location`, `form_name`, `form_topic`, `content_type`, `content_id`,
`search_type`, `search_mode`, `contact_method`, `checkout_type`, `error_code`, `status`.

## Rules

- Never put personal data in a param: no names, emails, phone numbers, message bodies, or
  typed chatbot questions. Search terms and starter-chip labels are fine.
- Param values are clamped to 100 characters (`sanitizeParams`); keep names ≤ 40 characters
  and snake_case.
- Prefer a GA4 recommended event name when one exists (`generate_lead`, `purchase`, `search`,
  `select_content`, `login`, `sign_up`, `begin_checkout`) — the built-in reports depend on it.
- Adding a tracked link in a server component: swap `Link`/`<a>` for `TrackedLink` and pass
  `event`; it picks `Link` vs new-tab `<a>` from the href.
- Adding a server-rendered outcome: render `<TrackEvent event={…} dedupeKey="…" />` next to
  the notice.
