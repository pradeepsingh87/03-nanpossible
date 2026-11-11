-- ============================================================
-- Migration: newsletter_signups (#164)
-- Durable record of every inline newsletter sign-up, and the
-- fallback when Constant Contact is unconfigured or unreachable
-- (status stays 'pending' so the address can be added later).
--
-- Deliberate deviation from the contact-form pattern: there is NO
-- anon insert policy. Rows are written only by the server action
-- through the service-role client, so anonymous visitors cannot
-- spam the table or flip a row's status. Platform admins can read.
-- ============================================================

create table if not exists public.newsletter_signups (
    id uuid primary key default gen_random_uuid(),
    email text not null,
    source text not null,
    site_tenant text,
    consent_text text not null,
    status text not null default 'pending'
        check (status in ('pending', 'subscribed', 'failed')),
    provider_error text,
    attempts integer not null default 1,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    subscribed_at timestamptz,
    constraint newsletter_signups_email_normalized check (email = lower(btrim(email))),
    constraint newsletter_signups_email_key unique (email)
);

alter table public.newsletter_signups enable row level security;

-- The server action writes with the service-role key.
grant select, insert, update on public.newsletter_signups to service_role;

drop policy if exists "Platform admins can read newsletter signups" on public.newsletter_signups;
create policy "Platform admins can read newsletter signups"
    on public.newsletter_signups
    for select
    to authenticated
    using (public.current_app_role() = 'platform_admin');
