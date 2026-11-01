# MiRoadmap core-system audit

Audit date: 2026-11-01

## Release status

The implemented individual-user product is internally consistent across the database contract, backend authorization and business rules, frontend flows, and admin workflows. The current release surface covers authentication, onboarding, legal acceptance, roadmap authoring and learning, verification, AI tailoring, recurring individual subscriptions, notifications, support, stories, feedback, newsletters, partnerships, and administration.

The audit removed product surfaces that claimed functionality without a persistent backend. The one-time `Urgent` plan is hidden until its purchase duration and roadmap-scoping rules are finalized. Static homepage/About/Support/Partnership “content editor” tabs are also hidden; Featured Stories remains available because it is backed by real CRUD APIs and database records.

## Business-rule matrix

| Area | Enforced rule / workflow | Status |
| --- | --- | --- |
| Authentication | Supabase identity is synchronized to an application user before product access | Implemented and E2E verified |
| Roles | USER, MODERATOR, ADMIN, and SUPER_ADMIN access is enforced by backend middleware | Implemented and E2E verified |
| Suspension | Admin restrictions, audit log, DB status, Supabase ban/unban, critical notification and email delivery record | Implemented; admin UI now calls the real endpoints |
| Onboarding | Profile completion, Terms acceptance, then Privacy acceptance are required in order | Implemented and E2E verified |
| Free roadmap creation | A standard free user may own one non-archived roadmap | Implemented with a per-user transactional lock to prevent concurrent quota bypass |
| Paid roadmap creation | Active, trialing, or comped plans use `MAX_CREATED_ROADMAPS`; null means unlimited | Implemented |
| Free follows | A standard free user may follow one active roadmap | Implemented and E2E verified |
| Paid follows | Active, trialing, or comped plans use `MAX_ACTIVE_FOLLOWS`; null means unlimited | Implemented |
| AI allowance | Free: 3 monthly adjustments; Premium: 25; Ultimate: 75 | Implemented and server-metered |
| AI security | Anthropic key is backend-only; input/output validation, safety decision, XP clamping, failure accounting | Implemented and tested |
| Official roadmaps | ADMIN/SUPER_ADMIN authored roadmaps are official and bypass community verification | Implemented and tested |
| Community verification | Evidence, admin decision with feedback, verified-state reset on edits, owner notification | Implemented and E2E verified |
| Roadmap learning | Follow/unfollow, sequential progress, idempotent task completion, XP bonuses, version updates | Implemented and E2E verified |
| Creator avatar | Roadmap creator identity resolves to the user's current profile image; anonymous attribution hides it | Implemented |
| Individual billing | Premium/Ultimate monthly and yearly Checkout, trial, webhook reconciliation, portal, invoices | Implemented |
| Stripe modes | Both `sk_test_...` and `sk_live_...` backend keys are accepted; publishable keys are rejected | Implemented and tested |
| Schools | $3,500 CAD for 120 seats routes into the verified partnership/sales workflow | Implemented as sales-led intake; seat activation remains an operational/admin process |
| Support | Authenticated ticket submission, user history, admin queue, priority/status, admin reply, user notification/email | Implemented and E2E verified |
| Roadmap requests | Public request form stores an admin-visible FEATURE_REQUEST instead of showing a false success state | Implemented |
| Feedback | Public anti-spam submission plus admin filtering, notes and status workflow | Implemented and E2E verified |
| Newsletter | Double opt-in, unsubscribe, suppression states, admin export, Mailchimp synchronization/webhook | Implemented; provider configuration pending |
| Partnerships | Verified-email inquiry, admin queue, handled state, audit log and team email | Implemented; provider configuration pending |
| Transactional email | Shared brand template, Supabase Auth templates, notification delivery records, Resend delivery webhook | Implemented; provider configuration pending |
| Analytics | Backend-derived metrics only; fabricated fallback data was removed | Implemented |

## Audit fixes made

- Enforced the advertised one-roadmap free-plan creation limit and returned `ROADMAP_CREATION_LIMIT_REACHED` on overflow.
- Serialized finite creation-quota checks so simultaneous requests cannot exceed the limit.
- Added coverage for free, finite paid, unlimited paid, canceled, trialing, comped, and privileged creation limits.
- Enabled production Stripe live secret keys while retaining test-mode detection.
- Wired admin Suspend and Reactivate buttons to the existing protected backend workflow.
- Replaced hardcoded admin saved-roadmap counts and last-active dates with backend values.
- Added Moderator and Deleted states to admin user presentation and removed non-functional user deletion controls.
- Removed fabricated analytics fallback data and disabled report export when analytics cannot load.
- Wired the public roadmap-request modal into the real admin feedback queue.
- Removed dead `#` links and replaced the unverified support telephone link with the platform's published Instagram and LinkedIn destinations.
- Hid the unfinished one-time Urgent checkout and non-persistent page-editor tabs so the UI no longer promises unavailable behavior.
- Made optional Resend initialization safe for local development and documented `RESEND_API_KEY`.

## Verification performed

- Backend TypeScript: passed.
- Backend unit/integration tests: 68 passed, 0 failed.
- Frontend ESLint: 0 errors (one pre-existing disabled-PWA callback warning).
- Frontend production build: passed; all 59 routes generated/type-checked.
- Database migration status: up to date.
- Database contract verification: passed; database schema matches the contract.
- Local platform E2E: 108 scenarios passed across auth, roles, onboarding, roadmap authoring, creation quota, publishing, following, XP, versioning, verification, notifications, AI guards, stories, feedback, billing, admin management, suspension, concurrency, and load.
- E2E mail-dependent scenarios could not run because the local SMTP port was not reachable. They are configuration-dependent; the mail domain/parser/template unit tests passed.

## Required deployment configuration

These are external credentials or provider resources, not missing application code:

- Resend/SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `MAIL_FROM`, public URLs, and the business postal address.
- Mailchimp: API key, server prefix, audience ID, and webhook secret. Register `/api/newsletter/mailchimp-webhook?secret=...` for unsubscribe and cleaned events from contact, admin, and API sources.
- Stripe: live secret, live webhook secret, and four recurring live Price IDs.
- Anthropic: backend-only `ANTHROPIC_API_KEY` and optional model selection.

## Explicitly deferred products

1. The one-time Urgent purchase is represented in the schema, but checkout and time/roadmap scope need a product decision before it can be safely sold.
2. School self-service organization creation, bulk invitations, and automated 120-seat enforcement are not exposed. The current School plan is deliberately sales-led through Partnerships.
3. General site-page CMS persistence is not exposed. Featured Stories is the only live content-management surface until public page content is moved into database-backed records.

