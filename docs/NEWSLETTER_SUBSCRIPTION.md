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
