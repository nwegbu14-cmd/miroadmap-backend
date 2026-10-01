# MiRoadmap Notification Centre — Delivery Phases

Status: living implementation roadmap  
Last updated: 2026-09-24

## 1. Purpose

This document records what has already been delivered in notification Phase 1 and defines the remaining phases. It is the implementation companion to `SUSPENSION_INFRASTRUCTURE.md`.

The notification centre is not the source of truth for roadmap, billing, enforcement, or verification state. It is a user-facing projection of durable domain events. A notification may link to a source record, but deleting or reading a notification must never change that source record.

## 2. Architecture principles

- Domain services emit events only after the corresponding business operation succeeds.
- A retry must not create duplicate notifications.
- Critical notifications are not suppressible through ordinary preferences.
- In-app creation and outbound delivery are separate operations.
- Email, push, and future channels reuse the same canonical notification event.
- Delivery failures never roll back the completed business operation.
- Links must be internal allowlisted routes or explicitly validated external URLs.
- Notification metadata must not contain secrets, raw evidence, tokens, or sensitive identity documents.
- Read, seen, delivered, and acted-on are different concepts.

## 3. Phase 1 — Core in-app notification centre

**Status: completed.**

Phase 1 established the storage, authenticated read APIs, user interface, and preferences foundation.

### Database foundation — complete

- [x] `Notification` model
- [x] Category and priority enums
- [x] Optional actor and target references
- [x] `dedupeKey` and `groupKey`
- [x] Seen/read/archive/expiry fields
- [x] `NotificationDelivery` model for future email and push attempts
- [x] `NotificationPreference` model
- [x] `PushSubscription` schema placeholder
- [x] Useful recipient/category/time indexes

### Backend foundation — complete

- [x] Create-notification helper
- [x] Cursor-based notification listing
- [x] All/unread filtering
- [x] Unread count
- [x] Mark one read
- [x] Mark one unread
- [x] Mark all read
- [x] Ownership checks by authenticated user
- [x] Read/update notification preferences
- [x] Input parsing and basic domain tests
- [x] Registered `/api/notifications` and `/api/notification-preferences` routes

### Frontend foundation — complete

- [x] Dashboard bell with unread badge
- [x] Recent-notification dropdown
- [x] New/earlier grouping
- [x] Mark-all-read interaction
- [x] Full `/user-dashboard/notifications` inbox
- [x] All/unread filter
- [x] Cursor-based “load more” interaction
- [x] Mark read/unread interaction
- [x] Internal-link navigation
- [x] Notification settings screen connected to the API
- [x] Loading, empty, and error states
- [x] Desktop and mobile-responsive presentation

### Deliberately not claimed as Phase 1

The following models or UI controls exist, but their complete runtime behaviour has not been implemented:

- domain-event producers across roadmaps, verification, billing, enforcement, and community features;
- transactional outbox/event dispatch;
- outbound email worker and provider integration;
- push-subscription registration endpoints and push worker;
- service worker display/click handling for real push payloads;
- Supabase Realtime, SSE, or WebSocket delivery;
- notification aggregation/digests;
- localization;
- admin delivery monitoring.

The current bell refreshes unread count at startup, on focus, after local notification actions, and every 60 seconds. That is an acceptable Phase 1 baseline, not real-time delivery.

## 4. Phase 2 — Domain events and critical communications

**Goal:** make real product activity reliably create in-app notifications, with mandatory email delivery for security and enforcement events.

Phase 2 should be completed alongside the suspension infrastructure because warnings, restrictions, appeals, suspensions, and restoration depend on it.

### 4.1 Notification event registry

Create one typed registry instead of scattering titles and copy through route handlers. Each definition contains:

- stable event type;
- category and default priority;
- user preference key, if suppressible;
- supported channels;
- required template variables;
- title/body renderers or template IDs;
- href builder;
- dedupe-key builder;
- optional group-key builder;
- retention/expiry policy;
- whether delivery is mandatory.

Suggested module boundary:

- `src/notifications/catalog.ts`
- `src/notifications/service.ts`
- `src/notifications/templates/`
- `src/notifications/delivery/`
- `src/notifications/workers/`

Routes call domain services. Domain services call the notification service. Route handlers must not construct free-form notification rows themselves.

### 4.2 Transactional event creation

Introduce a transactional outbox or equivalent durable event record.

Required sequence:

1. Perform the business mutation.
2. Write the domain/outbox event in the same database transaction.
3. Commit.
4. A worker claims the outbox event.
5. Create or upsert the canonical notification using a deterministic `dedupeKey`.
6. Create required channel-delivery rows.
7. Mark the outbox event processed only after durable notification creation.

This prevents the common failure where a suspension succeeds but its notification silently disappears because the process crashes between two unrelated writes.

If Prisma 18 transactions cannot cover an external provider call, that is expected: commit database state first and make provider delivery retryable afterward.

### 4.3 Phase 2 event catalogue

#### Account and enforcement — highest priority

| Event type | Priority | Channels | User-configurable |
| --- | --- | --- | --- |
| `ENFORCEMENT_WARNING_ISSUED` | High | In-app, email when material | No |
| `ENFORCEMENT_STRIKE_ISSUED` | High | In-app, email | No |
| `ACCOUNT_FEATURE_RESTRICTED` | High | In-app, email | No |
| `ACCOUNT_SUSPENDED` | Critical | In-app, email | No |
| `ACCOUNT_SECURITY_LOCKED` | Critical | In-app, email | No |
| `ENFORCEMENT_APPEAL_RECEIVED` | High | In-app, email | No |
| `ENFORCEMENT_APPEAL_DECIDED` | Critical | In-app, email | No |
| `ACCOUNT_RESTORED` | Critical | In-app, email | No |
| `PASSWORD_CHANGED` | High | In-app, email | No |
| `EMAIL_CHANGED` | High | In-app, old/new email as appropriate | No |

The in-app suspension record remains available through the restricted account portal even though the normal notification bell is unavailable.

#### Verification

| Event type | Priority | Recipient |
| --- | --- | --- |
| `VERIFICATION_REQUEST_RECEIVED` | Normal | Requester |
| `VERIFICATION_REQUEST_IN_REVIEW` | Normal | Requester |
| `VERIFICATION_APPROVED` | High | Requester |
| `VERIFICATION_DECLINED` | High | Requester |
| `VERIFICATION_MORE_INFO_REQUIRED` | High | Requester |

Verification notices respect the `verification` preference except for fraud/security enforcement, which uses mandatory enforcement events instead.

#### Roadmaps

| Event type | Priority | Recipient |
| --- | --- | --- |
| `ROADMAP_PUBLISHED` | Normal | Creator |
| `ROADMAP_REJECTED` | High | Creator |
| `ROADMAP_UPDATE_AVAILABLE` | Normal | Followers pinned to an older version |
| `ROADMAP_FOLLOWED` | Low | Creator |
| `ROADMAP_UNFOLLOWED` | Low | Normally analytics only, not a notification |
| `ROADMAP_DEADLINE_APPROACHING` | High | Follower |
| `ROADMAP_CONTENT_QUARANTINED` | High | Creator |

Follower events should use `groupKey` so a busy creator sees “12 people followed your roadmap” rather than 12 noisy rows.

#### Community and messaging

- `CONNECTION_REQUESTED`
- `CONNECTION_ACCEPTED`
- `DIRECT_MESSAGE_RECEIVED`
- `COMMUNITY_REPORT_RECEIVED` for the reporter's acknowledgement
- `COMMUNITY_REPORT_RESOLVED` when a safe status update can be disclosed

Do not notify the reported user merely because a report was filed. Notify them only when an actual user-visible action is taken.

#### Achievement and product

- `XP_AWARDED`
- `MILESTONE_REACHED`
- `BADGE_EARNED`
- `PLAN_PROMOTION_GRANTED`
- `FEATURE_ANNOUNCEMENT`

These are suppressible and lower priority. Do not let them obscure account or deadline notices.

#### Billing and support

- `PAYMENT_SUCCEEDED`
- `PAYMENT_FAILED`
- `SUBSCRIPTION_RENEWING`
- `SUBSCRIPTION_CHANGED`
- `SUBSCRIPTION_CANCELLED`
- `PROMO_EXPIRING`
- `SUPPORT_TICKET_RECEIVED`
- `SUPPORT_TICKET_REPLIED`
- `SUPPORT_TICKET_RESOLVED`

Security-relevant billing notices may be mandatory; receipts and contractual billing messages follow the applicable transactional-email rules. Product-news preferences must never suppress them.

### 4.4 Preferences and mandatory notices

Create a single policy function:

`resolveDeliveryPlan(event, preferences, accountState) -> channels and reason`

Rules:

- in-app records are created for all user-visible account actions;
- mandatory account/security/enforcement notices bypass optional category preferences;
- optional email is gated by both the global `email` switch and its category switch;
- optional push is gated by both the global `push` switch and its category switch;
- sound and vibration are client presentation settings, not delivery channels;
- a disabled channel records `SKIPPED` with a machine-readable reason when a delivery row is useful for auditing.

### 4.5 Critical email subset

Phase 2 includes the minimum email capability needed to safely launch suspension:

- provider abstraction, without hard-coding business logic to one vendor;
- branded templates for warning, restriction, suspension, appeal receipt/decision, and restoration;
- retry with exponential backoff;
- idempotent provider requests where supported;
- maximum-attempt handling and admin-visible failures;
- no secrets or private enforcement evidence in template variables;
- development sink/log mode so local Supabase development works without sending real mail.

Supabase Auth templates remain responsible for OTP/magic-link/password authentication messages. Application enforcement and activity email belongs to the MiRoadmap notification delivery service.

### 4.6 Phase 2 completion checklist

- [ ] Typed event registry exists.
- [ ] Domain/outbox event is persisted atomically with each important business mutation.
- [ ] Worker processes events idempotently.
- [ ] Enforcement lifecycle emits every mandatory event.
- [ ] Verification lifecycle emits requester events.
- [ ] Roadmap publish/update/follow lifecycle emits applicable events.
- [ ] Deadline scheduler emits due/overdue events without duplicates.
- [ ] Billing and support emit their minimum critical events.
- [ ] Critical email templates render correctly on desktop and mobile.
- [ ] Failed critical delivery is retryable and visible to admins.
- [ ] Tests prove retries do not duplicate notifications.

## 5. Phase 3 — Real-time, push, and delivery resilience

**Goal:** reduce polling latency and add reliable opt-in device delivery.

### Real-time in-app updates

Choose one transport after measuring deployment constraints:

- Supabase Realtime on inserts scoped by authenticated recipient;
- server-sent events from the backend;
- WebSockets when bidirectional transport is genuinely needed.

Requirements:

- recipient isolation must be enforced server-side/RLS, not only in the client;
- reconnect with backoff;
- refetch unread count after reconnect;
- avoid double-rendering an item received both by real-time event and list refresh;
- retain periodic/focus refresh as a fallback.

### Web push

- [ ] Add subscribe/unsubscribe endpoints for `PushSubscription`.
- [ ] Validate and rotate expired subscriptions.
- [ ] Store VAPID configuration outside source control.
- [ ] Implement service-worker display and click routing.
- [ ] Request browser permission only after contextual user intent.
- [ ] Remove endpoints after permanent delivery errors.
- [ ] Respect push and category preferences.
- [ ] Never expose sensitive suspension or verification detail on a lock screen; use generic copy where needed.

### Email-delivery hardening

- [ ] Provider webhooks for delivered, bounced, complained, and suppressed states.
- [ ] Signed webhook verification and replay protection.
- [ ] Bounce/suppression handling.
- [ ] Dead-letter queue and manual retry tooling.
- [ ] Provider health metrics and alerts.

### Phase 3 completion definition

- Bell state normally updates within seconds.
- Disconnect/reconnect does not lose or duplicate notifications.
- Push is genuinely opt-in and revocable.
- Critical delivery failures are operationally visible.
- Sensitive notification copy is safe on shared device lock screens.

## 6. Phase 4 — Aggregation, digests, localization, and intelligence

**Goal:** improve signal-to-noise and operate the system at scale.

### Grouping and digests

- Collapse follower, reaction, and similar high-volume events by `groupKey`.
- Offer daily/weekly digests for non-urgent roadmap and community activity.
- Never delay critical account, security, billing-failure, deadline, or enforcement notices into a digest.
- Add quiet hours and per-channel delivery windows.

### User controls

- Per-category channel matrix rather than only global switches.
- Frequency choices: immediate, daily digest, weekly digest, off.
- Quiet hours with user timezone.
- Device/subscription management.
- Notification archive/delete controls where retention policy permits.

### Localization and accessibility

- Template keys instead of persisted English-only business copy for newly generated events.
- Locale captured at event creation or delivery time according to product policy.
- Localized date/time and timezone handling.
- Screen-reader announcements that do not interrupt current work unnecessarily.
- Reduced-motion and keyboard-complete bell/inbox interactions.

### Admin operations and analytics

- Delivery-health dashboard by channel/provider/template.
- Search by notification ID, event ID, user, and dedupe key.
- Safe resend for failed mandatory messages.
- Template preview/test-send tooling.
- Metrics: created, seen, read, clicked, delivered, failed, suppressed, grouped.
- Alert thresholds for queue age and failure rates.
- Privacy-aware retention and deletion jobs.

### Intelligent recommendations

AI may help summarize groups or suggest wording, but must not:

- decide whether a user is suspended;
- change notification priority without deterministic safeguards;
- expose private source data;
- invent a policy reason or resolution step.

## 7. Canonical event payload

Use a stable internal envelope similar to:

```ts
type DomainNotificationEvent = {
  id: string;
  type: string;
  occurredAt: string;
  recipientId: string;
  actorId?: string;
  entity?: { type: string; id: string };
  data: Record<string, string | number | boolean | null>;
  schemaVersion: number;
  correlationId?: string;
  causationId?: string;
};
```

Do not put rendered HTML, access tokens, signed storage URLs, raw moderation results, or private case notes in this envelope.

## 8. Dedupe and grouping conventions

Suggested dedupe format:

`{eventType}:{entityType}:{entityId}:{recipientId}:{eventVersion}`

Examples:

- `VERIFICATION_APPROVED:verificationRequest:req_123:user_456:1`
- `ACCOUNT_SUSPENDED:enforcementAction:act_123:user_456:1`
- `ROADMAP_UPDATE_AVAILABLE:roadmapVersion:ver_12:user_456:1`

Suggested grouping format:

- `ROADMAP_FOLLOWED:{roadmapId}:{creatorId}`
- `DIRECT_MESSAGE_RECEIVED:{connectionId}:{recipientId}`
- `XP_AWARDED:{recipientId}:{yyyy-mm-dd}`

The dedupe key prevents duplicate events. The group key allows multiple legitimate events to be presented together. They are not interchangeable.

## 9. Priority rules

| Priority | Intended use | Presentation |
| --- | --- | --- |
| Low | Informational/social | Inbox; usually grouped or digestible |
| Normal | Expected product activity | Inbox and optional channel delivery |
| High | Timely action required | Prominent inbox; email/push according to policy |
| Critical | Account security, suspension, irreversible deadline | Immediate mandatory channels and operational monitoring |

Product announcements must never be marked critical. Critical priority should remain rare enough to preserve trust.

## 10. Testing strategy

### Unit tests

- registry completeness and required variables;
- preference/delivery-plan resolution;
- href allowlisting;
- dedupe and grouping-key generation;
- renderer escaping and missing-variable failures;
- priority rules.

### Integration tests

- business mutation plus outbox record is atomic;
- retries create one notification and one delivery per channel;
- one user cannot read or mutate another user's notification;
- mandatory notices bypass optional preferences;
- suspended users can read only their allowed enforcement notices;
- cursor pagination is stable when new rows arrive;
- email provider failures do not roll back business actions.

### End-to-end tests

- unread badge and dropdown refresh;
- deep link marks notification read and opens the correct record;
- warning → suspension → appeal → restoration sequence;
- notification settings affect optional events only;
- real-time reconnect and polling fallback;
- mobile push click routing;
- screen-reader and keyboard behaviour.

## 11. Operational runbook requirements

Before Phase 2 is considered production-ready, document:

- how to inspect an event and its delivery attempts;
- how to retry a failed mandatory email safely;
- how to disable one broken template or channel;
- how to drain/replay the outbox without duplication;
- how to respond to provider outages;
- how to rotate email/push credentials;
- how notification data is retained and purged;
- who can view sensitive account/enforcement notices.

## 12. Recommended next implementation slice

The next slice should be intentionally narrow:

1. approve suspension rule codes and add enforcement models;
2. add the typed notification event registry;
3. implement the transactional enforcement service and outbox path;
4. ship only the enforcement/account event family first;
5. add critical branded email delivery;
6. add the restricted suspended-account portal;
7. then expand event producers to verification, roadmaps, deadlines, billing, support, and community activity.

This sequence validates the most safety-critical path without attempting every notification type at once.

