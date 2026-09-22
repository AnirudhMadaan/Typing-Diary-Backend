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
  return { id: user.id, name: user.name, email: user.email, createdAt: user.createdAt };
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
  const seconds = typeof body?.seconds === "number" && Number.isFinite(body.seconds)
    ? Math.max(0, Math.round(body.seconds))
    : 0;
  if (!title || title.length > 140) return { error: "Give your entry a title up to 140 characters." };
  if (!content || content.length > 50000) return { error: "Write something before saving (up to 50,000 characters)." };
  const words = countWords(content);
  const wpm = seconds > 0 ? Math.round(words / (seconds / 60)) : 0;
  return { title, content, mood, seconds, words, wpm };
}

// Fixed CORS configuration for Vercel
app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(cookieParser());
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => res.send("Typing Diary API is live!"));
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Please enter a name between 2 and 80 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
  const state = await getState();
  if (state.users.some((user) => user.email === email)) return res.status(409).json({ error: "An account with that email already exists." });
  const { hash, salt } = hashPassword(password);
  const user = { id: randomUUID(), name, email, passwordHash: hash, passwordSalt: salt, createdAt: new Date().toISOString() };
  await updateState((current) => current.users.push(user));
  setSession(res, user.id);
  return res.status(201).json({ user: publicUser(user) });
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

export default app;