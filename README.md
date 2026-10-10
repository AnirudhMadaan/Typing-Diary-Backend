# Typing Diary — Backend

Express API for the static frontend. Deploy this folder as its own Vercel project.

## Environment variables

Required for deployment:

- `SESSION_SECRET` — a long, random value used to sign sessions.
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — durable account, entry, and settings storage.
- `FRONTEND_URL` — the deployed frontend origin, for example `https://diary.example.com`.
- `FRONTEND_ORIGIN` — that same exact origin, used to restrict credentialed browser requests.
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` — Google OAuth web client settings. Keep the secret only in backend environment variables.

For local development, copy `.env.example` to `.env`, fill in the OAuth and Upstash values, and set `GOOGLE_REDIRECT_URI` to `http://localhost:8080/api/auth/google/callback`. In your shell, load the file before starting the server with `set -a && . ./.env && set +a`. If you are only testing email/password locally, Google OAuth variables can be omitted.

Google Cloud Console must list the backend callback URL as an authorized redirect URI. Add the frontend origin to authorized JavaScript origins. The application requests only the OpenID Connect `openid email profile` scopes.

Run locally:

```bash
npm install
npm start
```

The API listens on port 8080. For local-only storage, `SESSION_SECRET` is still required; when not running on Vercel the API writes its JSON data file under `backend/data/`.

## Vercel deployment

Import the repository and set the Vercel project root to `backend/`. Add the environment variables above in Vercel, then deploy. The `api/` entry point and `vercel.json` route API requests to Express. Use a custom domain or sibling subdomains for the frontend and API when possible so browser cookie policies do not block cross-site sessions.
