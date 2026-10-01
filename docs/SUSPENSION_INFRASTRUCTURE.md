# MiRoadmap Suspension and Enforcement Infrastructure

Status: implementation guide  
Last updated: 2026-09-24

## 1. Purpose

This document defines the infrastructure required to warn, restrict, suspend, restore, and—when absolutely necessary—terminate MiRoadmap accounts.

The system must do more than toggle `User.status`. It must:

- apply published rules consistently;
- distinguish content enforcement from account enforcement;
- preserve an immutable decision history;
- tell the affected user what happened and what they can do next;
- support correction, expiry, appeal, and restoration;
- protect existing roadmap followers from unsafe content without unnecessarily destroying useful roadmap history;
- connect every user-visible enforcement action to the notification and email infrastructure.

Suspension is reversible. Termination/deletion is a separate, higher-risk workflow and must not be implemented as a synonym for suspension.

## 2. Current project baseline

The project already has pieces that the enforcement system can build on:

- `User.status`, `suspendedAt`, and `suspendedReason` in `miroadmap-schema/src/prisma/contract.prisma`;
- `AdminAuditLog` for immutable privileged-action records;
- `ContentReport`, `ModerationCheck`, and `ModerationPolicy` for reports and Sightengine/manual review;
- `VerificationRequest` and private `EvidenceFile` records;
- `Notification`, `NotificationDelivery`, and notification preferences;
- an admin suspend/reactivate modal in the frontend;
- role-aware backend middleware.

The current admin modal is not a working suspension system. It collects a free-text reason and changes local React state only. There is no suspension API, enforcement case, appeal, persisted restoration record, session revocation, email, or restricted user experience.

The existing user-dashboard guard redirects any non-active user to `/login`. That must be replaced with a dedicated suspended-account route so the user does not enter a login loop.

## 3. Enforcement principles

1. **Proportionality:** take the narrowest action that adequately protects users and the platform.
2. **Human confirmation:** an automated moderation score may quarantine content or open a case, but must not normally impose a punitive account suspension by itself.
3. **Clear notice:** identify the rule, effect, duration, affected content, and available resolution or appeal path.
4. **Separation of concerns:** removing one unsafe image is not the same as suspending its uploader's entire account.
5. **Auditability:** every enforcement and override records who, what, when, why, and the before/after state.
6. **No hidden punishment:** internal risk signals can remain private, but the user must receive a meaningful public explanation.
7. **Security locks are not strikes:** a compromised-account lock protects the user and must not count as misconduct.
8. **Safe appeals:** appealing a decision does not create an additional penalty.
9. **No destructive restoration:** restoring an account does not automatically republish quarantined content.
10. **Policy versioning:** every case records the exact policy rule and version applied at decision time.

## 4. Enforcement ladder

| Level | Action | Account access | Typical use |
| --- | --- | --- | --- |
| 0 | Quarantine/review | Normal except affected content | Automated media or text flag |
| 1 | Warning/content action | Normal | First low-severity confirmed violation |
| 2 | Strike/feature restriction | Login allowed; selected capabilities blocked | Material or repeated violation |
| 3 | Temporary suspension | Restricted suspension portal only | Serious or repeated violations |
| 4 | Indefinite suspension | Restricted suspension portal only | Fraud, investigation, unresolved risk |
| 5 | Termination | No normal product access | Severe abuse or persistent intentional violations |

Feature restrictions should be individually representable:

- `PUBLISH_ROADMAP`
- `EDIT_PUBLISHED_ROADMAP`
- `SUBMIT_VERIFICATION`
- `UPLOAD_MEDIA`
- `USE_AI`
- `SEND_DIRECT_MESSAGE`
- `CREATE_CONNECTION`
- `FOLLOW_ROADMAP`
- `REDEEM_PROMOTION`

Do not add a new `UserStatus` for every restriction. Full account state remains simple; active restrictions are derived from current enforcement actions.

## 5. Initial policy-rule catalogue

Stable codes should be stored with each case. Public wording can evolve through versioned policy definitions without changing historical records.

| Code | Public category | Normal starting action | Severe/repeated action |
| --- | --- | --- | --- |
| `UNSAFE_EXPLICIT_CONTENT` | Unsafe or explicit content | Quarantine/remove content and warn | Temporary or indefinite suspension |
| `HARMFUL_MISLEADING_GUIDANCE` | Harmful or materially misleading guidance | Unpublish roadmap and warn/strike | Publishing restriction or suspension |
| `SCAM_PHISHING_FRAUD` | Scam, phishing, or fraud | Immediate quarantine and investigation | Indefinite suspension/termination |
| `VERIFICATION_FRAUD` | False verification evidence | Decline request and restrict verification | Suspension for intentional/repeated fraud |
| `IMPERSONATION` | Impersonation or false credentials | Restrict affected profile/content | Indefinite suspension pending proof |
| `PRIVACY_SENSITIVE_DATA` | Privacy or sensitive-data violation | Remove/quarantine data immediately | Suspension for doxxing or intentional exposure |
| `HARASSMENT_HATE_THREAT` | Harassment, hate, threat, or exploitation | Remove content/restrict messaging | Immediate suspension for credible threats |
| `SPAM_MANIPULATION` | Spam or platform manipulation | Warning and feature restriction | Temporary suspension |
| `INTELLECTUAL_PROPERTY` | Intellectual-property violation | Restrict disputed content during review | Suspension for repeated confirmed violations |
| `ACCOUNT_COMPROMISE` | Account security issue | Protective lock and session revocation | Remains locked until secured; never a strike |
| `PAYMENT_PROMO_ABUSE` | Payment or promotion abuse | Restrict paid/promotion features | Suspension for confirmed intentional fraud |
| `ENFORCEMENT_EVASION` | Circumventing an enforcement action | Investigate linked accounts | Indefinite suspension/termination |
| `LEGAL_REGULATORY` | Legal or regulatory requirement | Scope action to the validated request | Super-admin-controlled suspension/termination |
| `OTHER` | Other policy violation | Manual review | Requires detailed justification and elevated approval |

### MiRoadmap-specific interpretation

`HARMFUL_MISLEADING_GUIDANCE` includes fabricated government requirements, guaranteed immigration outcomes, false deadlines, or presenting personal experience as authoritative legal advice. Incorrect information should first be assessed for intent, severity, source quality, and the likelihood of real-world harm.

`VERIFICATION_FRAUD` applies to deliberate falsification. A declined verification request, an incomplete document, or a good-faith mistake is not automatically misconduct.

`PAYMENT_PROMO_ABUSE` does not include an ordinary failed payment. Failed payments should downgrade or restrict paid features through billing logic.

## 6. Recommended strike behaviour

For ordinary, non-critical violations:

- first low-severity incident: warning without a strike;
- first confirmed material violation: strike plus up to a 7-day relevant feature restriction;
- second active strike: up to a 30-day relevant feature restriction;
- third active strike: temporary account suspension and mandatory review;
- active strike window: 90 days;
- expired strikes remain in the private history but no longer drive automatic escalation;
- critical abuse may bypass warnings and strikes.

The rule engine recommends an action; it does not blindly impose one. Severity, intent, reach, prior history, affected users, and real-world risk must remain part of the decision.

## 7. Data-model blueprint

Keep `User.status` as the fast current-state field. Replace `suspendedReason` as the source of truth with a case/action history.

### `PolicyRule`

- `id`
- `code`
- `version`
- `publicTitle`
- `publicDescription`
- `defaultSeverity`
- `defaultAction`
- `strikeEligible`
- `active`
- `effectiveAt`
- `retiredAt`
- unique `(code, version)`

For the first release, these rules may be seeded and changed only through reviewed migrations. A policy-management UI can come later.

### `EnforcementCase`

- `id`
- `userId`
- `ruleId`
- `status`: `OPEN`, `UNDER_REVIEW`, `AWAITING_USER`, `APPEALED`, `RESOLVED`, `CLOSED`
- `severity`: `LOW`, `MEDIUM`, `HIGH`, `CRITICAL`
- `source`: `ADMIN`, `REPORT`, `MODERATION`, `SECURITY`, `BILLING`, `LEGAL`, `SYSTEM`
- optional source references such as `reportId` or `moderationCheckId`
- affected entity type and ID
- `customerSummary`
- `internalNote`
- `openedById`
- `assignedToId`
- policy snapshot metadata
- `openedAt`, `resolvedAt`, `closedAt`

### `EnforcementAction`

Append-only records for every decision:

- `id`
- `caseId`
- `userId`
- `type`: `WARNING`, `STRIKE`, `FEATURE_RESTRICTION`, `CONTENT_QUARANTINE`, `CONTENT_UNPUBLISH`, `TEMPORARY_SUSPENSION`, `INDEFINITE_SUSPENSION`, `RESTORATION`, `TERMINATION`
- optional restricted capability
- `startsAt`, `expiresAt`, `revokedAt`
- `issuedById`
- `customerMessage`
- `internalReason`
- `policyCode` and `policyVersion`
- before/after state snapshots
- `createdAt`

Never overwrite the original suspension action during restoration. Append a `RESTORATION` action and close the effective restriction.

### `EnforcementAppeal`

- `id`
- `caseId`
- `userId`
- `statement`
- optional safe evidence references
- `status`: `SUBMITTED`, `IN_REVIEW`, `APPROVED`, `PARTIALLY_APPROVED`, `DENIED`, `WITHDRAWN`
- `reviewerId`
- `decisionMessage`
- `internalDecisionNote`
- `submittedAt`, `reviewedAt`

One appeal per action is a reasonable starting rule. A new appeal may be opened when materially new evidence exists.

### Existing models to retain

- `AdminAuditLog`: immutable security/audit copy of every privileged mutation.
- `ContentReport`: user reports remain evidence sources, not enforcement history.
- `ModerationCheck`: automated/manual content assessment remains evidence, not the final account decision.
- `Notification` and `NotificationDelivery`: all user-facing enforcement communication.
- `UserActivity`: may show a sanitized account timeline to admins, but must not replace the audit log.

## 8. Backend service boundary

All enforcement changes must go through one service, for example `EnforcementService`. Routes must not directly update `User.status`.

The service owns:

1. authorization and target-role checks;
2. validation of rule, duration, severity, and required notes;
3. creation of the case and append-only action;
4. account/feature/content state changes;
5. audit-log creation;
6. notification and delivery creation;
7. session revocation when necessary;
8. idempotency;
9. restoration and expiry handling.

Use a database transaction for the case, action, account state, audit record, notification, and delivery/outbox record. External email or Supabase calls happen after commit through a retryable worker.

### Minimum endpoints

Admin/moderator:

- `GET /api/admin/enforcement/rules`
- `GET /api/admin/users/:userId/enforcement-cases`
- `POST /api/admin/users/:userId/enforcement-cases`
- `POST /api/admin/enforcement-cases/:caseId/actions`
- `POST /api/admin/enforcement-actions/:actionId/restore`
- `GET /api/admin/enforcement-appeals`
- `POST /api/admin/enforcement-appeals/:appealId/decision`

Restricted user:

- `GET /api/account/enforcement-status`
- `GET /api/account/enforcement-cases/:caseId`
- `POST /api/account/enforcement-cases/:caseId/appeal`
- `GET /api/account/enforcement-appeals/:appealId`

The restricted routes use authentication without `requireActiveUser`. They authorize only the subject user and return sanitized fields.

## 9. Authorization matrix

| Actor | Allowed target/action |
| --- | --- |
| Moderator | Review reports and recommend content actions; no full account suspension initially |
| Admin | Warn/restrict/suspend normal users; cannot act on admins or super admins |
| Super admin | Act on users, moderators, and admins; approve permanent termination and legal actions |
| System | Quarantine content or create a protective security lock/case; no ordinary punitive suspension |

Additional protections:

- no self-suspension;
- no suspension of the last active super admin;
- permanent termination requires reauthentication and two-person approval when staffing permits;
- an admin cannot review their own appealed decision when another qualified reviewer exists;
- `OTHER`, critical overrides, and policy exceptions require an internal note.

## 10. Admin experience

Replace the current suspend textarea with a guided drawer or multi-step modal:

1. select policy rule;
2. select affected content/evidence;
3. confirm severity;
4. review the recommended action;
5. choose duration and restricted capabilities;
6. choose content impact;
7. write the customer-facing explanation;
8. write a separate private internal note;
9. preview the in-app and email notices;
10. confirm the action.

The restoration flow must require:

- a resolution code;
- customer-facing restoration message;
- private internal note;
- decision on each quarantined/unpublished item;
- confirmation of whether active strikes remain;
- confirmation that stale sessions will be revoked.

## 11. Suspended-user experience

Create `/account-suspended`, separate from the normal dashboard. A suspended user may authenticate but receives a restricted session experience.

Display:

- status and enforcement type;
- public reason and policy link;
- case number;
- issued date and expiry/review date;
- affected content and unavailable capabilities;
- required corrective steps;
- appeal status;
- appeal and support actions;
- logout and account-security actions.

Allowed backend operations while suspended:

- read the user's sanitized enforcement case;
- submit/read an appeal;
- password reset and account-security recovery;
- contact support;
- privacy/data requests where legally required;
- logout.

All ordinary roadmap, AI, community, and billing mutations remain blocked unless a specific safe resolution step needs them.

For a compromised-account lock, revoke existing sessions and require fresh authentication plus password/security recovery. Do not ban the user at the Supabase Auth layer in a way that makes the resolution portal impossible to reach.

## 12. Roadmap and content behaviour

Suspension does not always remove all roadmaps.

| Cause | Default published-roadmap behaviour |
| --- | --- |
| Security lock | Leave safe content available |
| Payment issue | Leave content available; restrict paid capabilities only |
| One unsafe asset | Quarantine affected asset/version |
| Harmful guidance | Unpublish affected roadmap/version and stop new follows |
| Fraud or impersonation | Quarantine all creator content pending review |
| Harassment in messages | Restrict messaging; leave unrelated roadmaps available |
| Permanent termination | Review content individually before archival/removal |

Never delete roadmap versions merely to enforce visibility. Followers may be pinned to an immutable version. Safety enforcement should mark availability explicitly and provide a safe explanation or replacement path.

## 13. Notifications and email

Every user-visible action creates a `Notification` in the same transaction as the action. Critical account actions also create an `EMAIL` delivery job.

Required notification types:

- `ENFORCEMENT_WARNING_ISSUED`
- `ENFORCEMENT_STRIKE_ISSUED`
- `ACCOUNT_FEATURE_RESTRICTED`
- `ACCOUNT_SUSPENDED`
- `ACCOUNT_SECURITY_LOCKED`
- `ENFORCEMENT_APPEAL_RECEIVED`
- `ENFORCEMENT_APPEAL_DECIDED`
- `ACCOUNT_RESTORED`
- `ACCOUNT_TERMINATED`

Use deterministic dedupe keys, for example:

`enforcement:{actionId}:{notificationType}:{userId}`

Suspension, security, appeal-decision, restoration, and termination notices are mandatory transactional communications. Users cannot disable them with marketing or community-notification preferences.

Email templates must include:

- MiRoadmap branding;
- action and effective date;
- public rule category;
- meaningful customer-facing explanation;
- affected capability/content when safe to disclose;
- duration or next review date;
- case number;
- resolution steps;
- appeal/support link.

Never include reporter identity, private admin notes, raw Sightengine scores, internal fraud signals, or sensitive evidence in notifications or email.

## 14. Appeal and restoration workflow

1. User opens the signed-in restricted portal or a verified email link.
2. User reads the policy and submits an appeal or completes the prescribed resolution step.
3. Case changes to `APPEALED` or `AWAITING_USER`.
4. Receipt notification/email is created.
5. An eligible reviewer evaluates the original evidence and the appeal.
6. Reviewer approves, partially approves, or denies with both public and internal reasoning.
7. The decision appends a new action, audit record, and notification.
8. If restored, stale sessions are revoked and the user signs in again.
9. Content stays quarantined until its own restoration decision is recorded.

Temporary suspensions may expire automatically only when the action is explicitly eligible for automatic restoration. Security, fraud, legal, and critical safety cases require human closure.

## 15. Public policy documents

The final product should publish four related documents:

1. **Terms of Service:** high-level right to restrict, suspend, or terminate for violations, security, fraud, legal requirements, and platform protection.
2. **Community Guidelines:** plain-language behavioural rules and examples.
3. **Roadmap Publishing Guidelines:** sourcing, attribution, AI-assisted content, harmful advice, government/legal claims, uploads, and verification evidence.
4. **Enforcement and Appeals Policy:** warnings, strikes, restrictions, duration, notification, appeal, restoration, and termination.

The Terms should incorporate the other policies by reference. Do not publish raw moderation thresholds or internal risk scores. Version the public documents and use the existing `TermsAcceptance` infrastructure when a material change requires renewed acceptance.

Have the production wording reviewed by qualified Canadian counsel. This document is a product/engineering specification, not legal advice.

## 16. Operational controls

- Rate-limit report and appeal submissions.
- Malware-scan and privately store appeal evidence.
- Use signed URLs with short lifetimes for sensitive evidence.
- Apply retention and purge rules to identity and immigration documents.
- Redact sensitive fields from application logs.
- Require idempotency keys for enforcement mutations.
- Add structured logs and alerts for failed critical-email delivery.
- Provide an admin queue for expiring temporary suspensions and overdue appeals.
- Add a kill switch for automated enforcement recommendations.
- Keep policy rules deterministic and testable; do not let generative AI make final suspension decisions.

## 17. Implementation sequence

### Stage A — Policy and schema

- [ ] Approve rule codes, severity definitions, strike window, and role matrix.
- [ ] Draft Community Guidelines and Enforcement and Appeals Policy.
- [ ] Add policy, case, action, appeal, and restriction models to `contract.prisma`.
- [ ] Generate and apply the Prisma migration/contract update.
- [ ] Seed the initial policy-rule versions.

### Stage B — Enforcement backend

- [ ] Implement a transactional enforcement service.
- [ ] Implement admin case/action/restoration endpoints.
- [ ] Implement role and target protections.
- [ ] Create immutable audit entries.
- [ ] Create notification and delivery/outbox records.
- [ ] Add expiry processing and idempotency.

### Stage C — Admin UI

- [ ] Replace free-text suspend/reactivate modals with guided workflows.
- [ ] Show enforcement history on the user detail page.
- [ ] Add queues for open cases, appeals, and expiring suspensions.
- [ ] Add evidence access with permission checks and audit logging.

### Stage D — Restricted user portal

- [ ] Add `/account-suspended`.
- [ ] Update frontend guards to route suspended users there.
- [ ] Allow only enforcement, security, support, privacy, and logout APIs.
- [ ] Add appeal and resolution forms.

### Stage E — Communication and operations

- [ ] Add branded enforcement email templates.
- [ ] Add retryable critical-email delivery.
- [ ] Add restoration and appeal notifications.
- [ ] Add admin SLA/failed-delivery monitoring.

### Stage F — Verification

- [ ] Unit-test escalation and expiration rules.
- [ ] Integration-test atomic case/action/audit/notification creation.
- [ ] Test admin role boundaries and last-super-admin protection.
- [ ] Test suspended-user API denial and allowed resolution routes.
- [ ] Test notification deduplication and delivery retry.
- [ ] Test that restoration does not republish quarantined content.
- [ ] Test accessibility and mobile behaviour of both admin and user flows.

## 18. Launch definition of done

The suspension feature is not ready to ship until all of the following are true:

- a suspension survives refresh and server restart;
- the decision has a versioned policy reason and immutable audit trail;
- active sessions are handled according to the action type;
- normal APIs reject the suspended user;
- the user can still understand and challenge the decision;
- a critical email is queued and retryable;
- an in-app record exists even if email fails;
- restoration is recorded separately from suspension;
- affected roadmap content has an explicit availability decision;
- tests cover unauthorized and duplicate actions;
- public policy and support procedures are available.

## 19. External reference points

- NIST account lifecycle guidance: <https://pages.nist.gov/800-63-4/sp800-63a/accounts/>
- OWASP session-management guidance: <https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>
- Example of progressive platform enforcement and appeals: <https://support.google.com/youtube/answer/2802032>

