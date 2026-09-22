# Typing Diary — Backend

Express API for Typing Diary. Deploy this folder as a separate Vercel project.

## Required Vercel environment variables

- `SESSION_SECRET` — long random secret
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

The backend uses Upstash Redis in Vercel so accounts, diary entries, and synced settings persist across devices.
