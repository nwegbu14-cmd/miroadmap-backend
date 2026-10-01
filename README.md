# miroadmap-backend

Express API for MiRoadmap. See [AUTH_SETUP.md](./AUTH_SETUP.md) for authentication/authorization setup and [miroadmap-schema](./miroadmap-schema) for the Prisma data contract.

## Requirements

- Node.js `26` (the repository pins `26.10.0`)
- A container runtime for local Supabase (Docker Desktop, or Colima + Docker CLI)

## Local Supabase

Local Supabase runs its stack (Postgres, Auth, Storage, Studio, etc.) as containers, so a Docker-compatible runtime must be running first.

### One-time setup (Colima + Docker CLI)

Docker Desktop works too, but Colima is a lighter, free, CLI-only alternative:

```sh
brew install docker colima
```

### Every session

```sh
colima start        # starts the container runtime (skip if Docker Desktop is already running)
npx supabase start  # starts the local Supabase stack
```

`npx supabase status` prints the local URLs and keys (API URL, Studio URL, anon/service role keys, DB URL). Use these values for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.env` — see [AUTH_SETUP.md](./AUTH_SETUP.md#environment).

Studio (local dashboard UI) runs at `http://127.0.0.1:54323`.

### Shutting down

```sh
npx supabase stop
colima stop
```

## Run the API

```sh
nvm use
npm run dev
```

## Roadmap Copilot

The roadmap-tailoring workflow is server-side and uses Anthropic's Messages API with strict structured output. To enable it, add the following to `.env` and restart the API:

```sh
ANTHROPIC_API_KEY=your-anthropic-api-key
# Optional; defaults to Claude Sonnet 5.
ANTHROPIC_MODEL=claude-sonnet-5
```

Never expose the key through a `NEXT_PUBLIC_` variable. Users must follow an AI-enabled roadmap and have a plan with the `CAN_USE_AI` entitlement. The model only proposes task changes; each proposal must be accepted before it is stored in the user's private `RoadmapPersonalization` overlay.
