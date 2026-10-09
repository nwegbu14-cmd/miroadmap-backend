# Featured story roadmap rollout

This release adds an optional roadmap link to featured stories. The database change is additive: existing stories remain valid with a null `roadmapId`, and deleting a roadmap clears the link instead of deleting the story.

## Current content mapping

Only one existing match is supported by the current titles and content:

| Featured story | Roadmap | Action |
| --- | --- | --- |
| `story-1` — How I got my first $10,000 in funding! | `featured-1` — How I Got My First $10,000 In Funding | Link automatically |
| `story-2` — How I built wealth from scratch with a simple app | None | Leave unlinked |
| `story-3` — How I grew my social media followers in 30 days | None | Leave unlinked |

Do not connect either unmatched story to the PGWP or test roadmap merely to populate the button. An admin can link them later after a genuinely matching, public, approved roadmap is published.

## Production order

Use the production database connection for the migration and backfill commands.

1. Create a manual logical backup. Free Supabase projects do not include downloadable managed backups, so use the Supabase CLI steps below and store the files somewhere outside the repository.
2. From `miroadmap-schema`, check the pending migration with `npm run migration:status` and `npm run migration:show`.
3. Apply the additive migration with `npm run migrate`.
4. Deploy the backend. It reads and validates the new `roadmapId` field.
5. From the backend root, run `npm run backfill:story-roadmaps`. The script is idempotent and validates that both records exist and that the roadmap is published, public, approved, and has a published version before it writes anything.
6. Deploy the frontend.

The schema must be migrated before deploying the backend because the new backend selects the `roadmapId` column. The older backend safely ignores the new nullable column, so this order does not require downtime.

## Free Supabase backup

In the Supabase dashboard, open **Connect**, choose the **Session pooler**, and copy its connection string. Use the database password when prompted or place the completed connection string in a temporary environment variable. Do not commit it.

```bash
export MIROADMAP_PROD_DB_URL='postgresql://...'
mkdir -p "$PWD/../miroadmap-production-backup"

npx supabase db dump --db-url "$MIROADMAP_PROD_DB_URL" \
  -f "$PWD/../miroadmap-production-backup/roles.sql" --role-only

npx supabase db dump --db-url "$MIROADMAP_PROD_DB_URL" \
  -f "$PWD/../miroadmap-production-backup/schema.sql"

npx supabase db dump --db-url "$MIROADMAP_PROD_DB_URL" \
  -f "$PWD/../miroadmap-production-backup/data.sql" --use-copy --data-only

unset MIROADMAP_PROD_DB_URL
```

Confirm that all three files exist and are non-empty before migrating. Copy them to encrypted off-site storage; the data export can contain personal user information. The Supabase CLI applies Supabase-specific filtering that a raw `pg_dump` does not, making these files more suitable for a later Supabase restore.

This database dump does not contain the actual files stored in Supabase Storage. This release changes only PostgreSQL tables and does not modify Storage objects, so a separate Storage export is not required for this migration.

## Verification

After deployment:

1. Open Featured Stories as a visitor. The funding story should show **Explore Roadmap**; the two unmatched stories should not show a roadmap button.
2. Open the funding roadmap while signed out on desktop and mobile. Check every task in steps 1 through 3. A sign-up/sign-in prompt should appear after step 3, and step 4 should not be checkable while signed out.
3. Sign in through the prompt. Confirm that the user follows the roadmap and that the guest checkmarks appear in the signed-in roadmap.
4. In Admin → Content Management, edit a story. Confirm that the roadmap dropdown lists only published, public, approved roadmaps and that selecting **No linked roadmap** removes the visitor button.
5. Run the backfill again. It should report that the links are already up to date and make no changes.

## Rollback

If the frontend or backend must be rolled back, deploy the previous application versions. The nullable database column can remain without affecting the older code. To hide the new link while leaving the release deployed, choose **No linked roadmap** in the story editor. Avoid dropping the column during an urgent rollback; that is unnecessary and adds risk.
