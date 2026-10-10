import 'dotenv/config';
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Redis } from "@upstash/redis";

const app = express();
const port = Number(process.env.PORT || 8080);
const sessionSecret = process.env.SESSION_SECRET;
const dataDirectory = process.env.DATA_DIR || path.resolve(process.cwd(), "data");
const dataFile = path.join(dataDirectory, "typing-diary.json");
const cookieName = "typing_diary_session";
const googleStateCookie = "typing_diary_google_state";
const sessionLifetime = 60 * 60 * 24 * 30;
let statePromise;
let writeQueue = Promise.resolve();

// Vercel Functions are stateless. Use Upstash Redis when deployed so accounts
// and diary entries survive cold starts and new serverless instances.
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const redis = redisUrl && redisToken ? new Redis({ url: redisUrl, token: redisToken }) : null;
const redisStateKey = "typing-diary:state:v2";

if (!sessionSecret) {
  throw new Error("SESSION_SECRET must be set before starting the Typing Diary backend.");
}

const emptyState = () => ({ users: [], entries: [] });

async function readLocalState() {
  return readFile(dataFile, "utf8")
    .then((contents) => {
      const parsed = JSON.parse(contents);
      return Array.isArray(parsed.users) && Array.isArray(parsed.entries) ? parsed : emptyState();
    })
    .catch((error) => {
      if (error.code === "ENOENT") return emptyState();
      throw error;
    });
}

async function getState() {
  statePromise ??= (async () => {
    if (redis) {
      const stored = await redis.get(redisStateKey);
      if (!stored) return emptyState();
      const parsed = typeof stored === "string" ? JSON.parse(stored) : stored;
      return Array.isArray(parsed.users) && Array.isArray(parsed.entries) ? parsed : emptyState();
    }
    if (process.env.VERCEL) {
      throw new Error("Persistent database is not configured. Add UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to Vercel.");
    }
    return readLocalState();
  })();
  return statePromise;
}

async function saveState(state) {
  if (redis) {
    await redis.set(redisStateKey, state);
    return;
  }
  await mkdir(dataDirectory, { recursive: true });
  const temporaryFile = `${dataFile}.tmp`;
  await writeFile(temporaryFile, JSON.stringify(state, null, 2), "utf8");
  await rename(temporaryFile, dataFile);
}

async function updateState(callback) {
  const current = await getState();
  callback(current);
  writeQueue = writeQueue.then(() => saveState(current));
  await writeQueue;
  return current;
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    username: user.username || usernameFromName(user.name),
    bio: user.bio || "",
    avatar: user.avatar || "",
    provider: user.googleSub ? "google" : "password",
    email: user.email,
    createdAt: user.createdAt,
  };
}

function usernameFromName(value) {
  const base = String(value || "writer")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20);
  if (!base) return "writer";
  return base.length < 3 ? `${base}_writer`.slice(0, 24) : base;
}

function uniqueUsername(state, requested, exceptUserId = "") {
  const base = usernameFromName(requested).slice(0, 20);
  const taken = (candidate) => state.users.some((user) =>
    user.id !== exceptUserId &&
    (user.username || usernameFromName(user.name)).toLowerCase() === candidate.toLowerCase()
  );
  if (!taken(base)) return base;
  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${base.slice(0, 24 - String(suffix).length - 1)}_${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}_${randomBytes(3).toString("hex")}`;
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

function verifyPassword(password, user) {
  const candidate = Buffer.from(hashPassword(password, user.passwordSalt).hash, "hex");
  const expected = Buffer.from(user.passwordHash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

function signSession(userId) {
  const payload = `${userId}.${Date.now() + sessionLifetime * 1000}`;
  const encoded = Buffer.from(payload).toString("base64url");
  const signature = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  return `${encoded}.${signature}`;
}

function userIdFromRequest(req) {
  const token = req.cookies?.[cookieName];
  if (!token) return undefined;
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return undefined;
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", sessionSecret).update(payload).digest("base64url");
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) return undefined;
  const [userId, expiresAt] = payload.split(".");
  return userId && Number(expiresAt) > Date.now() ? userId : undefined;
}

async function requireUser(req, res) {
  const userId = userIdFromRequest(req);
  if (!userId) {
    res.status(401).json({ error: "Please sign in to access your diary." });
    return undefined;
  }
  return userId;
}

function setSession(res, userId) {
  const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  res.cookie(cookieName, signSession(userId), {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    maxAge: sessionLifetime * 1000,
    path: "/",
  });
}

function countWords(text) {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function normalizeEntry(body) {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const content = typeof body?.content === "string" ? body.content.trim() : "";
  const mood = typeof body?.mood === "string" ? body.mood.trim().slice(0, 24) : "";
  const pageProfile = normalizePageProfile(body?.pageProfile);
  const globalProfile = normalizeGlobalProfile(body?.globalProfile);
  const seconds = typeof body?.seconds === "number" && Number.isFinite(body.seconds)
    ? Math.max(0, Math.round(body.seconds))
    : 0;
  if (!title || title.length > 140) return { error: "Give your entry a title up to 140 characters." };
  if (!content || content.length > 50000) return { error: "Write something before saving (up to 50,000 characters)." };
  const words = countWords(content);
  const wpm = seconds > 0 ? Math.round(words / (seconds / 60)) : 0;
  return { title, content, mood, seconds, words, wpm, pageProfile, globalProfile };
}

function normalizePageProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const fonts = new Set(["dm", "lora", "fraunces", "caveat", "patrick", "kalam", "mono"]);
  const pages = new Set(["lined", "grid", "dots", "paper", "blank"]);
  const aligns = new Set(["left", "center", "right", "justify"]);
  return {
    font: fonts.has(profile.font) ? profile.font : "lora",
    pageStyle: pages.has(profile.pageStyle) ? profile.pageStyle : "lined",
    fontSize: Number.isFinite(Number(profile.fontSize)) ? Math.min(28, Math.max(12, Number(profile.fontSize))) : 16,
    lineHeight: Number.isFinite(Number(profile.lineHeight)) ? Math.min(2.6, Math.max(1.2, Number(profile.lineHeight))) : 1.9,
    editorWidth: Number.isFinite(Number(profile.editorWidth)) ? Math.min(980, Math.max(520, Number(profile.editorWidth))) : 720,
    align: aligns.has(profile.align) ? profile.align : "left",
    textColor: typeof profile.textColor === "string" && /^#[0-9a-fA-F]{6}$/.test(profile.textColor) ? profile.textColor : "",
  };
}

function normalizeGlobalProfile(profile) {
  if (!profile || typeof profile !== "object") return null;
  const palettes = new Set(["forest", "ink", "ocean", "rose", "lavender", "sunset"]);
  const icons = new Set(["✦", "✎", "♡", "☼", "☾", "❋", "◌"]);
  return {
    palette: palettes.has(profile.palette) ? profile.palette : "forest",
    accent: typeof profile.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(profile.accent) ? profile.accent : "",
    texture: profile.texture !== false,
    icon: icons.has(profile.icon) ? profile.icon : "✦",
    compact: profile.compact === true,
  };
}

// Fixed CORS configuration for Vercel
const configuredOrigins = [
  process.env.FRONTEND_ORIGIN,
  process.env.FRONTEND_URL,
  ...(process.env.EXTRA_FRONTEND_ORIGINS || "").split(","),
].filter(Boolean).map((origin) => origin.trim().replace(/\/+$/, ""));
const allowedOrigins = new Set([
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  ...configuredOrigins,
]);

app.use(cors({
  origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin.replace(/\/+$/, ""))),
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type"],
}));

app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => res.send("Typing Diary API is live!"));
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const requestedUsername = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : usernameFromName(name);
  const bio = typeof req.body?.bio === "string" ? req.body.bio.trim().slice(0, 280) : "";
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Please enter a name between 2 and 80 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
  if (!/^[a-z0-9_]{3,24}$/.test(requestedUsername)) return res.status(400).json({ error: "Username must be 3–24 characters using lowercase letters, numbers, or underscores." });
  const state = await getState();
  if (state.users.some((user) => user.email === email)) return res.status(409).json({ error: "An account with that email already exists." });
  if (state.users.some((user) => (user.username || usernameFromName(user.name)).toLowerCase() === requestedUsername)) return res.status(409).json({ error: "That username is already taken." });
  const { hash, salt } = hashPassword(password);
  const user = { id: randomUUID(), name, username: requestedUsername, bio, email, passwordHash: hash, passwordSalt: salt, createdAt: new Date().toISOString() };
  await updateState((current) => current.users.push(user));
  setSession(res, user.id);
  return res.status(201).json({ user: publicUser(user) });
});

app.get("/api/auth/google/start", (req, res) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    return res.status(503).json({ error: "Google sign-in is not configured yet. Add the Google OAuth settings to the backend environment." });
  }
  const state = randomBytes(32).toString("base64url");
  const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  res.cookie(googleStateCookie, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 5 * 60 * 1000,
    path: "/",
  });
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  }).toString();
  return res.redirect(url.toString());
});

app.get("/api/auth/google/callback", async (req, res) => {
  const frontendUrl = (process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || "").replace(/\/+$/, "");
  const redirectWithStatus = (key, value) => {
    const destination = frontendUrl ? new URL("/", `${frontendUrl}/`) : new URL("/", "http://localhost:5500");
    destination.searchParams.set(key, value);
    return res.redirect(destination.toString());
  };
  const stateCookie = req.cookies?.[googleStateCookie];
  res.clearCookie(googleStateCookie, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL),
    path: "/",
  });
  if (!frontendUrl) return res.status(500).send("Set FRONTEND_URL before configuring Google sign-in.");
  if (!req.query.state || !stateCookie || req.query.state !== stateCookie) {
    return redirectWithStatus("auth_error", "Google sign-in could not be verified. Please try again.");
  }
  if (typeof req.query.code !== "string") {
    return redirectWithStatus("auth_error", "Google sign-in was cancelled or did not complete.");
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: req.query.code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: process.env.GOOGLE_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Google token exchange failed:", tokenData.error || tokenResponse.status);
      return redirectWithStatus("auth_error", "Google sign-in could not be completed. Please try again.");
    }

    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const profile = await profileResponse.json();
    if (!profileResponse.ok || !profile.sub || !profile.email || profile.email_verified !== true) {
      return redirectWithStatus("auth_error", "Google did not provide a verified email address.");
    }

    const state = await getState();
    let user = state.users.find((candidate) => candidate.googleSub === profile.sub);
    if (!user) {
      const email = String(profile.email).trim().toLowerCase();
      user = state.users.find((candidate) => candidate.email === email);
      if (user) {
        // Google has verified the email, so an existing password account with
        // that address can be linked without replacing its password.
        await updateState((current) => {
          const matched = current.users.find((candidate) => candidate.id === user.id);
          matched.googleSub = profile.sub;
          matched.avatar = typeof profile.picture === "string" ? profile.picture : "";
          matched.name ||= String(profile.name || email.split("@")[0]).slice(0, 80);
          matched.username ||= uniqueUsername(current, profile.given_name || matched.name, matched.id);
          matched.bio ||= "";
        });
        user = (await getState()).users.find((candidate) => candidate.id === user.id);
      } else {
        const displayName = String(profile.name || profile.given_name || email.split("@")[0]).trim().slice(0, 80) || "Writer";
        let created;
        await updateState((current) => {
          created = {
            id: randomUUID(),
            name: displayName,
            username: uniqueUsername(current, profile.given_name || displayName),
            bio: "",
            avatar: typeof profile.picture === "string" ? profile.picture : "",
            email,
            googleSub: profile.sub,
            createdAt: new Date().toISOString(),
          };
          current.users.push(created);
        });
        user = created;
      }
    }

    setSession(res, user.id);
    return redirectWithStatus("auth", "success");
  } catch (error) {
    console.error("Google sign-in failed:", error);
    return redirectWithStatus("auth_error", "Google sign-in is temporarily unavailable. Please try again.");
  }
});

app.post("/api/auth/login", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const state = await getState();
  const user = state.users.find((candidate) => candidate.email === email);
  if (!user || !verifyPassword(password, user)) return res.status(401).json({ error: "Email or password is incorrect." });
  setSession(res, user.id);
  return res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (_req, res) => {
  const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  res.clearCookie(cookieName, { 
    httpOnly: true, 
    sameSite: isProduction ? "none" : "lax", 
    secure: isProduction, 
    path: "/" 
  });
  return res.status(204).send();
});

app.get("/api/auth/me", async (req, res) => {
  const userId = userIdFromRequest(req);
  const state = await getState();
  const user = state.users.find((candidate) => candidate.id === userId);
  if (!user) return res.status(401).json({ error: "Not signed in." });
  // Sliding session: an active user gets another 30 days whenever the app
  // checks the session, instead of being unexpectedly logged out.
  setSession(res, user.id);
  return res.json({ user: publicUser(user) });
});

// DELETE /api/auth/me - Delete current logged-in user account and their entries
app.delete("/api/auth/me", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  await updateState((current) => {
    // 1. Remove user entries
    current.entries = current.entries.filter((entry) => entry.userId !== userId);
    // 2. Remove user account
    current.users = current.users.filter((user) => user.id !== userId);
  });

  // Clear session cookie
  const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: isProduction ? "none" : "lax",
    secure: isProduction,
    path: "/",
  });

  return res.status(200).json({ message: "Account and associated entries deleted successfully." });
});

app.patch("/api/profile", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : "";
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Display name must be 2–80 characters." });
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "Username must be 3–24 characters using lowercase letters, numbers, or underscores." });
  if (bio.length > 280) return res.status(400).json({ error: "Bio must be 280 characters or fewer." });

  const state = await getState();
  if (state.users.some((user) => user.id !== userId && (user.username || usernameFromName(user.name)).toLowerCase() === username)) {
    return res.status(409).json({ error: "That username is already taken." });
  }
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    if (user) Object.assign(user, { name, username, bio });
  });
  const updatedUser = (await getState()).users.find((user) => user.id === userId);
  return res.json({ user: publicUser(updatedUser) });
});

app.get("/api/settings", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const user = state.users.find((candidate) => candidate.id === userId);
  return res.json({ settings: user?.settings || null });
});

app.put("/api/settings", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const page = normalizePageProfile(req.body?.page);
  const global = normalizeGlobalProfile(req.body?.global);
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    if (user) user.settings = { page, global, updatedAt: new Date().toISOString() };
  });
  const state = await getState();
  const user = state.users.find((candidate) => candidate.id === userId);
  return res.json({ settings: user?.settings || null });
});

app.get("/api/entries", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const entries = state.entries
    .filter((entry) => entry.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return res.json({ entries });
});

app.post("/api/entries", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const input = normalizeEntry(req.body);
  if (input.error) return res.status(400).json(input);
  const now = new Date().toISOString();
  const entry = { ...input, id: randomUUID(), userId, createdAt: now, updatedAt: now };
  await updateState((current) => current.entries.push(entry));
  return res.status(201).json({ entry });
});

app.put("/api/entries/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const input = normalizeEntry(req.body);
  if (input.error) return res.status(400).json(input);
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id && candidate.userId === userId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  await updateState((current) => {
    const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
    Object.assign(currentEntry, input, { updatedAt: new Date().toISOString() });
  });
  return res.json({ entry });
});

app.patch("/api/entries/:id/design", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const pageProfile = normalizePageProfile(req.body?.pageProfile);
  const globalProfile = normalizeGlobalProfile(req.body?.globalProfile);
  await updateState((current) => {
    const entry = current.entries.find((candidate) => candidate.id === req.params.id && candidate.userId === userId);
    if (!entry) return;
    entry.pageProfile = pageProfile || entry.pageProfile || null;
    entry.globalProfile = globalProfile || entry.globalProfile || null;
    entry.updatedAt = new Date().toISOString();
  });
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id && candidate.userId === userId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  return res.json({ entry });
});

app.delete("/api/entries/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  let deleted = false;
  await updateState((current) => {
    const before = current.entries.length;
    current.entries = current.entries.filter((entry) => !(entry.id === req.params.id && entry.userId === userId));
    deleted = current.entries.length !== before;
  });
  if (!deleted) return res.status(404).json({ error: "Entry not found." });
  return res.status(204).send();
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Typing Diary backend listening on http://localhost:${port}`);
  });
}

export default app;