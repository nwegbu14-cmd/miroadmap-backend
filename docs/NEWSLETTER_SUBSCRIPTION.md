# Newsletter subscription model

The landing-page email form should become a consent-based newsletter signup, not an account or product subscription.

## Recommended flow

1. A visitor submits a normalized email address and accepts concise marketing consent copy.
2. `POST /api/newsletter/subscriptions` returns the same generic response whether the address is new or already known, preventing account enumeration.
3. MiRoadmap sends a double-opt-in email containing a single-use confirmation token.
4. Clicking the token changes the record from `PENDING` to `ACTIVE` and records consent time, source page, document version, and IP.
5. Every marketing email contains a one-click unsubscribe URL. Unsubscribing changes the status to `UNSUBSCRIBED`; it never deletes the suppression record.

## Proposed data model

`NewsletterSubscription`

- `id`
- `emailNormalized` (unique)
- `status`: `PENDING | ACTIVE | UNSUBSCRIBED | BOUNCED | COMPLAINED`
- `source`
- `consentVersion`
- `consentedAt`
- `confirmedAt`
- `unsubscribedAt`
- `confirmationTokenHash`
- `confirmationExpiresAt`
- `ip`
- `userAgent`
- `createdAt`, `updatedAt`

Store only a hash of confirmation and unsubscribe tokens. Rate-limit by IP and normalized email, add a honeypot field, and do not reveal whether an address is already subscribed.

## Product boundaries

- Newsletter consent is separate from account creation and paid subscriptions.
- Creating an account must not silently subscribe someone to marketing email.
- Transactional account, security, moderation, and billing messages do not depend on newsletter consent.
- A future email provider should process delivery, bounce, and complaint webhooks idempotently.

## Delivery plan

1. Add the schema and migration.
2. Add subscribe, confirm, and unsubscribe endpoints plus rate limiting.
3. Choose an email provider and add signed webhook handling.
4. Wire the footer only after persistence and double opt-in are available. Until then, do not show a false success message or retain emails in browser storage.

## Implementation status (2026-10-26)

Steps 1, 2 and 4 are built; step 3 (provider webhooks) is not.

- **Schema:** `NewsletterSubscription` in `miroadmap-schema/src/prisma/contract.prisma`. Applied to the local database with `prisma db update`; production needs a proper migration (`prisma migration plan`). Tokens are stateless HMACs instead of stored hashes, so the token columns above are not needed. `confirmationSentAt` throttles resends (10 minutes).
- **Public API:** `POST /api/newsletter/subscriptions` (JSON, explicit `consent: true`, honeypot field `website`, 5 requests per 15 minutes per IP, same 202 reply for new and known addresses), `GET /api/newsletter/confirm?token=` (redirects to the site), and `POST /api/newsletter/unsubscribe` (token in the body or query; also serves the RFC 8058 one-click header).
- **Admin API (ADMIN, SUPER_ADMIN):** `GET /api/admin/newsletter` and `GET /api/admin/newsletter/export?format=mailchimp|google|full`. Mailchimp and Google exports contain confirmed subscribers only. Every export is written to `AdminAuditLog`.
- **Email pipeline:** `src/lib/email.ts` sends over SMTP (`SMTP_*`, `MAIL_FROM`) and renders the same branded layout as `supabase/templates/recovery.html`. Supabase Auth can only send its own auth emails, so the backend sends these itself; in production point both at the same SMTP provider. Messages: confirmation, welcome (with `List-Unsubscribe` headers), and a notice to `TEAM_NOTIFY_EMAIL` (formerly `NEWSLETTER_NOTIFY_EMAIL`, still read as a fallback; default `inquire@miroadmap.co`) when someone confirms.
- **Frontend:** footer form (checkbox consent, honeypot, success and error text), `/newsletter/confirmed`, `/newsletter/unsubscribe`, and `/admin/newsletter` with metrics, search, status filter and CSV downloads.
- **Local setup:** `smtp_port = 54325` is enabled under `[local_smtp]` in `supabase/config.toml`; restart the stack (`npx supabase stop && npx supabase start`) so Mailpit accepts mail from the API.
- **Tests:** `src/domain/newsletter.test.ts` (unit) and the "Newsletter" section of `src/scripts/e2e-platform.ts`.
