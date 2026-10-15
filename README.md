# Typing Diary — Backend

Standalone Express API for the static frontend. It listens on `PORT`, then `API_PORT`, then `8080`. If `../frontend/dist/` exists, it serves that frontend from the same origin as the API.

## Required environment

- `SESSION_SECRET` — long random value for signing session cookies.
- `FRONTEND_URL` and `FRONTEND_ORIGIN` — exact frontend origin (for local development, `http://localhost:5500`).
- `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` — required for durable deployments. Local development can omit them and use `data/typing-diary.json`.
- Optional Google OAuth: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`.

The server does not load `.env` automatically. Set variables in the shell before starting it. For local PowerShell:

```powershell
$env:SESSION_SECRET = "use-a-long-random-value"
$env:FRONTEND_URL = "http://localhost:5500"
$env:FRONTEND_ORIGIN = "http://localhost:5500"
npm install --registry=https://registry.npmjs.org
npm run dev
```

For Google login locally, set `GOOGLE_REDIRECT_URI` to `http://localhost:8080/api/auth/google/callback` and configure that exact URI in Google Cloud Console. Keep the Google client secret in backend environment variables only.

## Deployment

Set the Vercel project root to `backend/` (or deploy this folder as a Node service). Configure the required environment variables above; serverless deployments require Upstash because local files are not durable. This API continues to use the older project's Upstash key, `typing-diary:state:v2`.
