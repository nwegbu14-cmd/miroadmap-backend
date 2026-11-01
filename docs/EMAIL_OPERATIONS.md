# Email operations setup

The application wiring is complete. Provider credentials can be added later without changing code.

## Delivery responsibilities

- **Supabase Auth:** signup verification, login codes, password reset, email change, and other authentication messages.
- **Backend SMTP (Resend):** support replies, billing notices, account/security notices, roadmap verification updates, newsletter confirmation/welcome messages, and internal admin notices.
- **Mailchimp:** newsletter campaigns and audience management after a visitor completes MiRoadmap's double opt-in flow.

All application-generated messages use the canonical MiRoadmap grid, logo, colors, footer, plain-text alternative, and message-specific safety copy.

## Environment variables to activate later

Copy the mail section from `.env.example` into the production backend environment and replace the placeholders:

```dotenv
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_USER=resend
SMTP_PASS=re_your_secret_resend_api_key
MAIL_FROM=MiRoadmap <no-reply@miroadmap.co>
SUPPORT_EMAIL=support@miroadmap.co
TEAM_NOTIFY_EMAIL=inquire@miroadmap.co
MAIL_POSTAL_ADDRESS=Your full business mailing address
API_PUBLIC_URL=https://api.miroadmap.co
PUBLIC_SITE_URL=https://miroadmap.co
RESEND_WEBHOOK_SECRET=whsec_your_resend_signing_secret
```

`SMTP_PASS` uses a secret Resend API key, not a publishable key. `RESEND_WEBHOOK_SECRET` is a separate signing secret generated when the webhook is created.

For Mailchimp, add:

```dotenv
MAILCHIMP_API_KEY=your-mailchimp-api-key-usXX
MAILCHIMP_SERVER_PREFIX=usXX
MAILCHIMP_AUDIENCE_ID=your-audience-id
MAILCHIMP_WEBHOOK_SECRET=your-long-random-secret
```

## Provider dashboard steps

1. Verify the sending domain in Resend and publish its SPF and DKIM records. Keep the existing DMARC policy valid.
2. Register `https://api.miroadmap.co/api/email/resend-webhook` in Resend for `email.sent`, `email.delivered`, `email.delivery_delayed`, `email.bounced`, `email.complained`, `email.failed`, and `email.suppressed` events.
3. Set the Resend signing secret as `RESEND_WEBHOOK_SECRET` on the backend.
4. Point Supabase Auth SMTP at the same verified Resend sender. Auth templates remain managed with `npm run email:sync-auth-templates`.
5. Register `https://api.miroadmap.co/api/newsletter/mailchimp-webhook?secret=<MAILCHIMP_WEBHOOK_SECRET>` as the Mailchimp audience webhook for unsubscribe and cleaned-address events.
6. Open `/admin/email`, confirm every provider card is ready, and send a test email.
7. Open `/admin/newsletter` and run **Sync existing subscribers** once. New confirmed subscribers synchronize automatically after that.

`SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF` are only needed by the auth-template publishing command. They are not used for normal runtime email delivery.

## Admin controls

`/admin/email` is restricted to administrators and shows provider readiness, delivery counts, and the latest 50 application emails. It can send a test message to the signed-in administrator and retry transient failures. Provider-rejected bounces, complaints, and suppressed addresses are deliberately not retried.

`/admin/newsletter` shows Mailchimp readiness, performs the one-time active-subscriber backfill, and keeps CSV exports as a portable backup. Backfills, exports, test messages, and retries are recorded in `AdminAuditLog`.
