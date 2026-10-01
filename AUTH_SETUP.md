# Authentication setup

The Express API owns application authorization. Supabase owns identities,
passwords, OAuth sessions, email codes, and invitation delivery. The Prisma
`User.id` is the same UUID as the corresponding Supabase Auth user.

Use Node.js 26; the repository pins 26.10.0 for the API and Prisma schema runtime.

## Environment

1. Copy `.env.example` to `.env` in this directory.
2. Set `DATABASE_URL` to the Postgres URL used by `miroadmap-schema`.
3. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the Supabase project.
4. Add the initial owner's email to `SUPER_ADMIN_EMAILS`.
5. Copy the frontend `.env.example` to `.env.local` in the `miroadmap` project
   and set only the public Supabase URL, anon/publishable key, and API URL.

Never expose `SUPABASE_SERVICE_ROLE_KEY` through a `NEXT_PUBLIC_` variable.

## Supabase dashboard

- Add `http://localhost:3000/auth/callback`,
  `http://localhost:3000/create-password`, and the production equivalents to
  the Auth redirect allow list.
- Configure the email sign-in template to show `{{ .Token }}` because the app
  accepts a six-digit code. If the template only contains `{{ .ConfirmationURL }}`,
  Supabase sends a magic link instead.
- Enable Google in Auth Providers before using the Google buttons.

## Bootstrap the first super admin

Put the owner's email in `SUPER_ADMIN_EMAILS`, complete the normal signup flow,
and call the profile sync (the UI does this after verification). The backend
creates or promotes that one allow-listed identity to `SUPER_ADMIN`.

Afterward, the owner can use `/admin/users/add-user`. That form calls
`POST /api/admin/users`; the API verifies the Supabase JWT and requires the
database role to be `SUPER_ADMIN`. Supabase sends the invitation, and the API
creates the matching application user and immutable audit record in one
database transaction.

## Regular-user signup and onboarding

The required regular-user flow is:

1. Sign up with name and email.
2. Verify the six-digit email OTP.
3. Create a password.
4. Complete every onboarding question.
5. Continue through Terms, Privacy, and recommended roadmaps.
6. Enter `/user-dashboard`.

`PUT /api/auth/onboarding` validates and stores the residency status, length of
stay, main goal, province, and acquisition channel in `Profile`, then sets
`Profile.onboardedAt`. The auth profile responses expose `onboardingComplete`.
The frontend uses that server-backed value after login, auth callbacks, password
creation, and on every user-dashboard route, so closing the onboarding page does
not bypass it. Admin and super-admin accounts go directly to the admin area.

## Local run

From `miroadmap-backend`:

```sh
npm run dev
```

After changing `supabase/config.toml` or a local email template, restart the
local stack so Auth loads it:

```sh
npx supabase stop
npx supabase start
```

Password recovery uses the branded `supabase/templates/recovery.html` template
and displays `{{ .Token }}` as a six-digit recovery OTP. Hosted Supabase does
not read the local template file, so copy that template into the hosted
Dashboard's **Authentication → Email Templates → Reset password** template
before testing the production recovery flow.

Terms and Privacy acceptance are stored independently in `TermsAcceptance`.
Dashboard access requires completed profile questions plus acceptance of the
current Terms and Privacy document version; neither legal screen has a skip
action.

From `miroadmap`:

```sh
npm run dev
```

## Roadmap media storage

A roadmap must never store or publish the uploader's local computer path. A
browser file input does not expose a usable path (it commonly reports a value
such as `C:\\fakepath\\image.jpg`), and the API and other users cannot access a
file that exists only on the uploader's computer.

The temporary development flow compresses supported images in the browser and
embeds them in the draft as an inline data URL. This is only a bridge while
media storage is being integrated and is subject to strict request-size limits.
The production flow must:

1. Compress the image in the frontend.
2. Send it through Sightengine moderation.
3. Upload the approved file to a Supabase Storage bucket.
4. Save the resulting storage path in `TaskResource.storagePath`.
5. Generate the appropriate public or signed URL when returning roadmap data.

Local development can use the bucket provided by the local Supabase stack. The
file is still uploaded over HTTP to local Supabase Storage; the roadmap must not
reference a path on the developer's Mac or another user's computer.

## Profile avatars

The personal-information page compresses avatar uploads in the browser to a
maximum 512 px edge and roughly 450 KB, then sends them to the authenticated
`PUT /api/auth/avatar` endpoint. The API validates the MIME type, file signature,
and size before uploading to the public `avatars` bucket. Only the object path is
stored in `User.avatarPath`; auth responses expose a generated `avatarUrl`.

The API creates the bucket on demand for an existing environment. Restart the
local Supabase stack after pulling the `supabase/config.toml` change so a fresh
local stack also provisions it automatically. Sightengine moderation should be
inserted in the backend upload flow before public release; its credentials must
remain server-only.
