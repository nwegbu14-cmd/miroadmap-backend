# MiRoadmap email catalogue

Email is split by purpose so consent and delivery behavior remain predictable.

## Supabase Auth and security

The canonical HTML lives in `supabase/templates/` and covers confirmation,
invitation, OTP sign-in, recovery, email change, reauthentication, password and
contact-detail changes, linked identities, and MFA changes. Local Supabase reads
the files through `supabase/config.toml`.

Hosted Supabase does not read repository files automatically. Publish them with:

```sh
SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... npm run email:sync-auth-templates
```

Disable click tracking for Auth emails. Rewritten verification links can fail.

## Application transactional mail

`src/lib/email.ts` supplies the shared accessible, table-based branded shell.
`src/lib/notification-mail.ts` maps important account events to email:

- account suspended and restored;
- support request received, replied to, or updated;
- roadmap verification review, approval, or decline;
- subscription start, change, cancellation, payment receipt, or payment failure.

Critical account and payment notices are delivered even when optional email
preferences are disabled. Marketing consent never controls service messages.

## Admin operational mail

Admins receive new newsletter-subscriber, partnership-inquiry, and support-ticket
notices. Admin mail links back to the matching queue; replies should be recorded
through MiRoadmap rather than handled as disconnected email threads.

## Mailchimp marketing mail

Use one audience. Confirmed MiRoadmap newsletter subscribers are upserted into
Mailchimp with `newsletter` and `source-<source>` tags. Unsubscribes synchronize
in both directions, while cleaned and abuse records become local suppression
statuses.

Import the templates in `email-templates/mailchimp/` into Mailchimp and use this
starter journey:

1. Subscriber joins: the app sends the confirmation and subscription receipt.
2. Two days later: `welcome-followup.html` introduces useful roadmaps.
3. Regular editorial sends: `newsletter.html`.
4. After 90 days without engagement: one `reengagement.html`; suppress contacts
   who remain inactive.

Every marketing send must retain Mailchimp's unsubscribe, preference, sender
address, and archive merge tags. Do not upload account-only contacts to marketing
unless they separately consented.

## Production checklist

- Authenticate `miroadmap.co` with SPF, DKIM, and DMARC.
- Use a monitored reply-to address and a dedicated `no-reply` From address.
- Set the full physical business address in `MAIL_POSTAL_ADDRESS`.
- Set the Mailchimp webhook URL shown in `.env.example` and subscribe it to
  unsubscribe, cleaned, and profile-change events.
- Send tests to Gmail, Outlook, Apple Mail, and a plain-text inbox before launch.
- Monitor bounces, complaints, retries, and `NotificationDelivery` failures.
