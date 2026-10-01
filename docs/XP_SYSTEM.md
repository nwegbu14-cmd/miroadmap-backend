# MiRoadmap XP system

## Purpose

XP should reward useful progress through a roadmap. It must not be a currency, affect immigration outcomes, or be something a roadmap creator can inflate. The API is the authority; the browser may preview earned XP but cannot award it.

## Phase 1 rules

- A required task is worth 10 XP.
- An optional task is worth 5 XP.
- Completing every required task in a step awards a one-time 20 XP step bonus.
- Completing the roadmap awards a one-time 50 XP completion bonus.
- Viewing, following, creating, publishing, or repeatedly checking a task awards no XP.
- Unchecking a task reverses that task's XP and any no-longer-valid step or roadmap bonus. This prevents check/uncheck farming and keeps XP aligned with actual progress.
- Roadmap-authored `xp` values are display metadata only. The server clamps or replaces them with the platform rules above; user-created content cannot define arbitrary rewards.

## Required data behavior

`TaskCompletion` already gives task completion an idempotent identity. `RoadmapProgress.xpEarned` should be a cached total, not the transaction history.

Before persistent awards ship, add an append-only `XpLedgerEntry` model with:

- `id`
- `userId`
- `progressId`
- nullable `taskId` and `stepId`
- `eventKey` (unique idempotency key)
- `amount` (positive or negative)
- `reason` (`TASK_COMPLETED`, `TASK_REOPENED`, `STEP_COMPLETED`, `STEP_REOPENED`, `ROADMAP_COMPLETED`, `ROADMAP_REOPENED`, `ADMIN_ADJUSTMENT`)
- `roadmapVersionId`, so future roadmap edits cannot rewrite previously earned history
- `createdAt`

The completion endpoint must update the completion record, ledger, cached total, and notification in one database transaction. Duplicate requests with the same event key return the existing result.

## Versioning behavior

- A follower earns against the roadmap version attached to their `RoadmapProgress` fork.
- New tasks inherited from a newer source version begin incomplete and can award XP once.
- Removed or superseded tasks do not erase previously earned XP unless the user explicitly reopens that completed task.
- AI-created personal tasks use the optional-task reward unless the platform promotes them to required tasks.

## Notifications and abuse controls

- Notify for step bonuses, roadmap completion, and milestone levels; do not notify for every 10 XP task.
- Rate-limit completion writes and record suspicious rapid completion patterns for moderation.
- Never trust XP, completion timestamps, roadmap ownership, or task values supplied by the client.
- Admin adjustments require a reason and an audit-log entry.

## Delivery phases

1. **Current UI:** calculate the visible XP total from checked tasks so it no longer displays a hard-coded zero. This is session state only.
2. **Authoritative completion API:** persist task state and enforce sequential steps server-side.
3. **Ledger and bonuses:** add `XpLedgerEntry`, step/roadmap bonuses, reversals, and idempotency.
4. **Levels and achievements:** define thresholds only after real usage data shows a sustainable earning rate.

Do not add leaderboards in the initial release. MiRoadmap is a support product, and competitive ranking can reward rushing through tasks rather than completing them carefully.
