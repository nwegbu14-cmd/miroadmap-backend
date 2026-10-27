# MiRoadmap end-to-end test report

Date: 2026-10-25. Scope: backend API, then frontend (visitor, user, admin) against the local stack.

## How to reproduce

### Backend suite
`src/scripts/e2e-platform.ts` (run with `npm run test:e2e`) creates its own test accounts and refuses to run unless `SUPABASE_URL` is local.

Start an isolated API with rate limits off, then run it:

```sh
PORT=5002 DISABLE_RATE_LIMITS=1 SUPER_ADMIN_EMAILS=e2e-super@miroadmap.test \
  npx tsx index.ts
npm run test:e2e
```

- `DISABLE_RATE_LIMITS=1` is honored only when `NODE_ENV` is not `production` (`src/middleware/rate-limit.ts`). Remove it when no longer needed.
- Add `E2E_AUTH_LOAD=0` to skip the authenticated load phase.
- Last backend result: 102/102 checks pass, typecheck clean, 32/32 unit tests.

### Frontend
- Frontend: `/Users/davvead/Documents/PORTFOLIO/miroadmap` (Next.js), dev server on port 3002, calls the API at `NEXT_PUBLIC_API_URL` (5001).
- The backend `FRONTEND_URL` must include `http://localhost:3002`. CORS matches `localhost` only, not `127.0.0.1`.
- Ports 3000 and 3001 are other projects on this machine.
- Browser testing used the VS Code integrated browser. If the tab is hidden, `requestAnimationFrame` does not fire, so some pages look stuck ("Loading draft..."). Bring the tab to the foreground or shim it.

### Test accounts (local only)
Password for all: `E2e-Passw0rd!-local`

- `e2e-super@miroadmap.test` (SUPER_ADMIN, needs `SUPER_ADMIN_EMAILS` on the API)
- `e2e-admin@miroadmap.test` (ADMIN)
- `e2e-tester@miroadmap.test` (USER, TESTER account type)
- `e2e-ui-mvoo8cit@miroadmap.test` (USER, created through the UI signup flow)
- Per-run users: `e2e-creator-<run>@`, `e2e-follower-<run>@`, `e2e-*` invited users

Email codes are read from Mailpit: `http://127.0.0.1:54324/api/v1/search?query=to:<email>`.

### Local environment notes
- The `supabase_analytics` container starves the Docker VM (about 1.9 GB) and makes Supabase auth/db "unhealthy", causing login timeouts and 504s. Fix: set `[analytics] enabled = false` in `supabase/config.toml`.
- `miroadmap-schema/.env` has two `DATABASE_URL` lines; the second points at the hosted Supabase pooler and would win for tools run from that folder. Remove it and rotate that database password (it has appeared in plain text in chat).

## Backend findings

### Fixed
1. Mark-all-read only updated one row (ORM `update()` is single-row; use `updateAndCount()`). Same bug orphaned only one AI delta when accepting a roadmap update.
2. Concurrent task toggles returned 500 (duplicate key). Now treated as already done.
3. Notification preferences were stored but never applied. Now enforced when creating roadmap-update and verification notifications.
4. Author-supplied task XP (up to 1000) is ignored; required = 10, optional = 5.
5. Malformed JSON returns 400 and oversized bodies 413 (were 500).
6. Supabase outages/throttling return 503 instead of a 401 that logs users out.
7. Added after testing: billing notifications, 20 XP step bonus and 50 XP completion bonus, sequential step enforcement, completion notifications, suspension/reactivation APIs with audit records, critical notifications, pending email-delivery rows, product blocking and Supabase session bans, and AI XP clamping.

### Not a bug
- Publishing a community roadmap resets `isVerified` to false on purpose.

### Open or to note
- Email delivery rows for suspensions are created as `PENDING`, but nothing sends them yet.
- Suspended users cannot read their own notifications (routes require an active account); only `/api/auth/me` works for them.
- Backend CORS helper `isPrivateDevOrigin` only matches port 5001, which looks like a bug for LAN dev origins.

## Frontend breakdown

### Visitors

| Area | Result |
|---|---|
| Public pages (`/`, about, features, pricing, partnerships, support, legal, 404, offline) | Pass |
| Internal link crawl (24 links) | One failure: footer "Help center" -> `/help` was a 404 (the footer now links to `/support`) |
| Roadmap library, search, no-match message | Pass |
| Roadmap detail (public) | Pass. Checkboxes disabled with no sign-in prompt (may be intended) |
| Stories list and detail | Pass |
| Story and roadmap view counting | Pass (verified in backend log; once per session) |
| Story share button | Not verified |
| Feedback form | Pass. Reaches the backend and appears in admin Feedback |
| Newsletter "Subscribe" (footer) | Fixed. Double opt-in signup, confirmation and welcome emails, team notice to the inquiry inbox, admin Newsletter page with Mailchimp/Google/full CSV export, unsubscribe page. Verified in the browser |
| Click-every-control scan of all public pages | No dead controls left (Subscribe and the partnership form have since been wired; the rest were already-selected tabs or new-tab links) |
| Static featured roadmap data (`app/roadmaps/data.ts`) | Contains lorem ipsum placeholder text |
| Route guards | Pass |
| Signup (email code, wrong code rejected, password, onboarding, Terms, Privacy, dashboard) | Pass |

### Regular users and testers

| Area | Result |
|---|---|
| Password login and logout (with confirmation) | Pass |
| Onboarding enforcement (closing it does not bypass) | Pass |
| Dashboard and profile pages | Pass; XP comes from the server |
| Follow a roadmap and tick tasks, persisted after reload | Pass |
| Step bonus and "Step completed" notification | Pass (server awards 20 XP) |
| XP on the roadmap page | Fail: shows 20 XP while server and dashboard show 40 |
| Notifications (list, mark read, mark all read, bell badge) | Pass (16 to 0, persisted) |
| Notification preferences | Pass |
| Personal info save and phone validation | Pass |
| Create roadmap wizard, save draft, publish | Pass |
| Edit published roadmap (v2), follower banner, accept update | Pass; progress kept |
| Billing, free user | Pass; shows "Stripe setup pending" gracefully |
| Billing, tester simulator (subscribe, cancel, notifications) | Pass |
| Support ticket flow (user, admin reply, reply and notification back) | Pass |
| AI copilot | Pass; clear "add ANTHROPIC_API_KEY" message |
| Onboarding options | Minor: "2+ years" and "More than 5 years" both map to `TWO_PLUS_YEARS` |
| `/recommended-roadmaps` step | Inconsistent: shown to the tester, skipped for the UI user |
| Click-every-control scan of all 12 signed-in user pages | One dead control: deadlines "View all" on the dashboard (`href="#"`, `app/user-dashboard/page.tsx` ~497) |
| Local storage after logout | Minor: per-user roadmap draft data stays in the browser |
| Avatar crop and upload | Inconclusive (preview failed to load; possibly the hidden tab) |
| Delete own draft | Not tested |

### Admins and super admins

| Area | Result |
|---|---|
| Admin email-code sign-in | Pass |
| Password sign-in at `/login` for admins | Works, so the admin sign-in extra step is not enforced |
| Page sweep (11 admin pages) | Pass, no errors |
| Users list, detail, activity timeline | Pass |
| Invite user (super admin); ordinary admin redirected away | Pass |
| Suspend and reactivate | Fail: UI shows Suspended but reverts on reload; backend `/suspend` is never called |
| Feedback (filter, change status and note) | Pass |
| Verification (list, detail, approve with confirmation) | Pass; roadmap marked verified |
| Roadmaps (list, create official, publish) | Pass; published as official |
| Stories (create draft, publish, public listing, delete) | Pass |
| Support tickets (view and reply) | Pass |
| Analytics | Fake: hardcoded numbers (10,000 users, $24,608 MRR) |
| Content Management: Homepage, About, Partnership, Support tabs | Static sample rows from `data.ts`, not saved |
| Users table "View full table" link | Dead (`href="#"`, `app/admin/users/page.tsx` ~230) |
| Users table row "Edit <user>" buttons | Dead: clicking does nothing |
| Verification page "View full table" link | Dead (`href="#"`, `app/admin/verification/page.tsx` ~154) |
| Click-every-control scan of all admin pages | Dead controls are the three above; everything else responded |
| Analytics "Export report" | Works (generates a PDF) but exports the hardcoded sample data |
| Content Management "More pages coming soon" placeholder | Unfinished by design |
| Verification detail page | Minor: user "Status" box is blank |
| Users list "Saved Roadmaps" column | Suspicious: shows 0 for a user who follows a roadmap |
| Decline verification, admin roadmap edit/delete, story image upload, admin settings save, admin notification bell | Not tested |

## Round 2: "little things" (click every control, forms, auth edges)

Why round 1 missed these: it only checked that each page rendered without console errors. It never clicked every button or submitted every form. Round 2 combined a static scan of the code (TODO markers, `href="#"`) with an automated click of every link, button, tab and checkbox on every public, user and admin page. A control counted as dead if the click changed nothing: no navigation, no DOM change, no network request. Destructive controls (delete, publish, log out) were skipped, and already-selected tabs and new-tab links were treated as false positives.

### Dead or unwired controls found
| Where | Control | Finding |
|---|---|---|
| User dashboard (`app/user-dashboard/page.tsx` ~497) | Deadlines "View all" | `href="#"`, goes nowhere |
| Admin Users (`app/admin/users/page.tsx` ~230) | "View full table" | `href="#"`, dead |
| Admin Users | "Edit <user>" button on rows | Dead. Click does nothing |
| Admin Verification (`app/admin/verification/page.tsx` ~154) | "View full table" | `href="#"`, dead |
| Admin Content Management | Homepage/About/Partnership/Support tabs | Static sample rows, "More pages coming soon" placeholder |
| Admin Analytics | KPI cards and charts | Hardcoded sample data. "Export report" works but exports that fake data |
| `app/roadmaps/data.ts` | Lorem ipsum text in static featured roadmap data | Placeholder content |

### Auth edges
| Flow | Result |
|---|---|
| Wrong password and unknown email on login | Pass. "Invalid login credentials" shown |
| Signup validation (empty, bad email) | Pass. Message shown, no request sent |
| Signup with an already-registered email | Goes to the code screen (effectively a sign-in code to the owner). Acceptable |
| Non-admin at the admin sign-in page | Rejected after the code with "This account does not have admin access" |
| Forgot password: code screen, new password screen, same-password error, success | Pass, but see the recovery email problem below |
| Settings: update password | Pass |
| Google login / signup buttons | Navigate to Supabase and land on a raw JSON error ("Unsupported provider: provider is not enabled") because Google is not enabled locally. No friendly error |

### Password recovery email is wrong in this environment (important)
The UI asks for a 6-digit code, but the recovery email actually sent contains only a reset link, subject "Reset your password". The configured template in `supabase/templates/recovery.html` shows `{{ .Token }}` and has subject "Reset your MiRoadmap password", so the running Supabase Auth container is using its default template. Per `AUTH_SETUP.md`, restart the local stack so it loads the template:

```sh
npx supabase stop
npx supabase start
```

Until then a real user cannot finish password reset through the UI. I tested the rest of the flow by generating a code with the admin API (`/auth/v1/admin/generate_link`).

## Open frontend work (priority order)
1. Wire admin Suspend/Reactivate to `POST /api/admin/users/:id/suspend` and `/reactivate`.
2. Restart local Supabase (`npx supabase stop && npx supabase start`) so password-recovery emails contain the 6-digit code; until then users cannot finish a reset.
3. ~~Wire the home-page partnership form~~ Done, see "Partnerships" below.
4. ~~Wire the footer newsletter form~~ Done, see "Newsletter" below. Still needed in production: apply the `NewsletterSubscription` migration and set the SMTP, `API_PUBLIC_URL` and `PUBLIC_SITE_URL` variables.
5. Show server `xpEarned` on the roadmap page instead of computing it from checkboxes.
6. Fix the dead links and buttons: the three `href="#"` "View all" / "View full table" links, the admin Users row "Edit" button, and the footer "Help center" (`/help`, 404).
7. Replace analytics mock data with real metrics, or label it as sample data.
8. Back the Homepage, About, Partnership and Support content tabs with real storage, or hide them. Replace the lorem ipsum in `app/roadmaps/data.ts`.
9. Show a friendly message when an OAuth provider (Google) is not enabled.
10. Decide whether admins should be allowed to sign in with a password at `/login`.
11. Clear user-scoped local storage on logout.
12. Smaller items: duplicate onboarding option, `/recommended-roadmaps` inconsistency, blank verification "Status" box, "Saved Roadmaps" count.
13. Process: for every feature, add a test that clicks each control and asserts a visible result (navigation, request, or UI change), so dead buttons like these are caught automatically.

## Newsletter (added after the first report)
Backend e2e section "Newsletter (double opt-in, team notice, admin export)": 14 checks, all pass (validation, honeypot, no address enumeration, tampered links, confirm, team notice, welcome email with one-click unsubscribe headers, admin list and exports, audit log, unsubscribe, re-subscribe). Full run: 110 passed, 3 failed. The 3 failures are environmental: the CORS check used a different origin than the one configured for this run, and the OTP signup check reads a different mail inbox than the one Supabase writes to (the password step then failed as a consequence).

Browser checks: footer signup shows the confirmation message; the email link lands on `/newsletter/confirmed`; the admin Newsletter page lists subscribers and metrics; all three CSV buttons return 200 with attachment headers; the unsubscribe page works; 12 rapid signups return 400 then 429 once the limit is reached.

## Partnerships (added after the newsletter)
Flow: the home-page form takes an email and sends a "next steps" email with a signed 7-day link; the link opens `/partnerships/inquiry`, where the verified address is prefilled and the visitor gives name, organization, interest and an optional message; the inquiry is stored in `PartnershipInquiry` (no schema change), the sender gets an acknowledgement, and `inquire@miroadmap.co` gets a notice with Reply-To set to the sender. Admins triage under `/admin/partnerships` (search, status filter, details, mark handled; audited).

Backend e2e section "Partnerships": 8 checks, all pass. Full run: 118 passed, 3 failed, the same 3 environmental failures as before. Browser checks: home form message, email link, inquiry form (dark mode), thank-you page, admin list, detail dialog and mark-handled.

The public newsletter pages now use the shared public page frame (navbar, footer, dark mode, brand buttons) instead of the blue auth-card style; the new admin pages reuse the Feedback page layout.

## Test data left behind
The local `miroadmap_dev` database still holds about 46 users, many "E2E..." roadmaps (including published ones), some stories, feedback and support tickets created by these runs. Nothing was written to the hosted Supabase project.
