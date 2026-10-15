import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { Redis } from "@upstash/redis";
import { isEmailConfigured, generateVerificationCode, verifyCode, sendVerificationEmail } from "./emailService.js";

const app = express();
const backendDirectory = path.dirname(fileURLToPath(import.meta.url));

// Automatically load .env if present
if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(path.resolve(backendDirectory, ".env"));
  } catch {}
}

const frontendDist = path.resolve(backendDirectory, "../frontend/dist");
const frontendIndex = path.join(frontendDist, "index.html");
const sessionSecret = process.env.SESSION_SECRET || "typing-diary-local-development-session-secret-998877";
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

const emptyState = () => ({ users: [], entries: [] });

function normalizeState(value) {
  const state = value && Array.isArray(value.users) && Array.isArray(value.entries)
    ? value
    : emptyState();
  for (const user of state.users) {
    user.username ||= usernameFromName(user.name);
    user.bio ||= "";
    user.avatar ||= "";
    user.defaultPrivacy ||= "private";
    user.friendIds ||= [];
    user.friendRequestsSent ||= [];
    user.friendRequestsReceived ||= [];
    user.perFriendSettings ||= {};
    user.settings ||= {};
    user.settings = {
      soundEnabled: true,
      soundType: "mechanical",
      paperTheme: "parchment",
      defaultAnonymous: false,
      allowFriendRequests: true,
      showStatsByDefault: false,
      ...user.settings,
    };
    user.lastSeenAt ||= user.createdAt || new Date(0).toISOString();
  }
  for (const entry of state.entries) {
    entry.userId ||= entry.authorId;
    entry.visibility ||= "private";
    entry.allowedFriendIds ||= [];
    entry.tags ||= [];
    entry.mood ||= "reflective";
    entry.isAnonymous = entry.isAnonymous === true;
    entry.anonymousAlias ||= "";
    entry.privacySettings ||= { allowComments: true, allowReactions: true, showTypingStats: false };
    entry.typingStats ||= { wpm: entry.wpm || 0, totalKeystrokes: 0, durationMinutes: 0, words: entry.words || countWords(entry.content || "") };
    entry.reactions ||= { resonance: 0, hug: 0, bookmark: 0, inspire: 0 };
    entry.reactionUsers ||= { resonance: [], hug: [], bookmark: [], inspire: [] };
    entry.comments ||= [];
    entry.photoBlobs ||= [];
    entry.createdAt ||= entry.updatedAt || new Date(0).toISOString();
    entry.updatedAt ||= entry.createdAt;
  }
  return state;
}

async function readLocalState() {
  return readFile(dataFile, "utf8")
    .then((contents) => {
      return normalizeState(JSON.parse(contents));
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
      return normalizeState(parsed);
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

function publicUser(user, { includeEmail = true, includeSocial = true } = {}) {
  const result = {
    id: user.id,
    name: user.name,
    displayName: user.name,
    username: user.username || usernameFromName(user.name),
    bio: user.bio || "",
    avatar: user.avatar || "",
    provider: user.googleSub ? "google" : "password",
    authProvider: user.googleSub ? "google" : "custom",
    createdAt: user.createdAt,
    joinedDate: user.createdAt,
    defaultPrivacy: user.defaultPrivacy || "private",
    settings: user.settings || {},
    online: Date.now() - new Date(user.lastSeenAt || 0).getTime() < 5 * 60 * 1000,
  };
  if (includeEmail) result.email = user.email;
  if (includeSocial) {
    result.friendIds = user.friendIds || [];
    result.friendRequestsSent = user.friendRequestsSent || [];
    result.friendRequestsReceived = user.friendRequestsReceived || [];
    result.perFriendSettings = user.perFriendSettings || {};
  }
  return result;
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

function normalizeEntry(body, existing = {}) {
  const title = typeof body?.title === "string" ? body.title.trim() : (existing.title || "");
  const content = typeof body?.content === "string" ? body.content.trim() : (existing.content || "");
  const mood = typeof body?.mood === "string" ? body.mood.trim().slice(0, 24) : "";
  const pageProfile = normalizePageProfile(body?.pageProfile);
  const globalProfile = normalizeGlobalProfile(body?.globalProfile);
  const seconds = typeof body?.seconds === "number" && Number.isFinite(body.seconds)
    ? Math.max(0, Math.round(body.seconds))
    : Math.max(0, Number(existing.seconds) || 0);
  if (title.length > 140) return { error: "Keep the title to 140 characters or fewer." };
  if (!content && !title) return { error: "Write a title or something in your entry before saving." };
  if (content.length > 50000) return { error: "Keep entries under 50,000 characters." };
  const words = countWords(content);
  const wpm = seconds > 0 ? Math.round(words / (seconds / 60)) : 0;
  const validVisibility = new Set(["private", "friends", "custom_friends", "public"]);
  const visibility = validVisibility.has(body?.visibility) ? body.visibility : (existing.visibility || "private");
  const reactions = body?.privacySettings && typeof body.privacySettings === "object"
    ? body.privacySettings
    : existing.privacySettings || {};
  const stats = body?.typingStats && typeof body.typingStats === "object"
    ? body.typingStats
    : existing.typingStats || {};
  let photoBlobs = existing.photoBlobs || [];
  if (Array.isArray(body?.photoUploads)) {
    if (body.photoUploads.length > 3) return { error: "Add no more than 3 pictures to one diary." };
    photoBlobs = [];
    for (const upload of body.photoUploads) {
      if (typeof upload !== "string" || upload.length > 650_000) {
        return { error: "Each compressed picture must be smaller than 450 KB." };
      }
      const match = upload.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
      if (!match) return { error: "Diary pictures must be JPEG, PNG, or WebP images." };
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 450_000 || bytes.toString("base64") !== match[2]) {
        return { error: "Each compressed picture must be smaller than 450 KB." };
      }
      photoBlobs.push({
        id: randomUUID(),
        contentType: `image/${match[1]}`,
        data: bytes.toString("base64"),
      });
    }
  } else if (body?.photoUploads !== undefined) {
    return { error: "Diary pictures must be sent as a list of compressed images." };
  }
  const location = typeof body?.location === "string"
    ? body.location.trim().slice(0, 160)
    : (existing.location || "");
  const rawWeather = body?.weather && typeof body.weather === "object"
    ? body.weather
    : existing.weather;
  const weatherDate = typeof rawWeather?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawWeather.date)
    ? rawWeather.date
    : "";
  const weather = rawWeather && weatherDate
    ? {
      date: weatherDate,
      location: typeof rawWeather.location === "string" ? rawWeather.location.trim().slice(0, 160) : location,
      weatherCode: Number.isInteger(rawWeather.weatherCode) ? Math.min(99, Math.max(0, rawWeather.weatherCode)) : null,
      temperatureMaxC: Number.isFinite(rawWeather.temperatureMaxC) ? rawWeather.temperatureMaxC : null,
      temperatureMinC: Number.isFinite(rawWeather.temperatureMinC) ? rawWeather.temperatureMinC : null,
      description: typeof rawWeather.description === "string" ? rawWeather.description.slice(0, 60) : "Weather recorded",
    }
    : null;
  return {
    title,
    content,
    mood: mood || existing.mood || "reflective",
    seconds,
    words: Number.isFinite(Number(stats.words)) ? Math.max(0, Number(stats.words)) : words,
    wpm: Number.isFinite(Number(stats.wpm)) ? Math.max(0, Number(stats.wpm)) : wpm,
    visibility,
    isAnonymous: visibility === "public" && (body?.isAnonymous === true || (body?.isAnonymous === undefined && existing.isAnonymous === true)),
    anonymousAlias: typeof body?.anonymousAlias === "string" ? body.anonymousAlias.trim().slice(0, 40) : (existing.anonymousAlias || ""),
    allowedFriendIds: Array.isArray(body?.allowedFriendIds)
      ? [...new Set(body.allowedFriendIds.filter((id) => typeof id === "string"))].slice(0, 100)
      : (existing.allowedFriendIds || []),
    tags: Array.isArray(body?.tags)
      ? [...new Set(body.tags.filter((tag) => typeof tag === "string").map((tag) => tag.trim().replace(/^#/, "").slice(0, 32)).filter(Boolean))].slice(0, 12)
      : (existing.tags || []),
    location,
    weather,
    photoBlobs,
    typingStats: {
      wpm: Number.isFinite(Number(stats.wpm)) ? Math.max(0, Number(stats.wpm)) : wpm,
      totalKeystrokes: Number.isFinite(Number(stats.totalKeystrokes)) ? Math.max(0, Number(stats.totalKeystrokes)) : 0,
      durationMinutes: Number.isFinite(Number(stats.durationMinutes)) ? Math.max(0, Number(stats.durationMinutes)) : Math.round(seconds / 60),
      words: Number.isFinite(Number(stats.words)) ? Math.max(0, Number(stats.words)) : words,
    },
    privacySettings: {
      allowComments: reactions.allowComments !== false,
      allowReactions: reactions.allowReactions !== false,
      showTypingStats: reactions.showTypingStats === true,
    },
    pageProfile: pageProfile || existing.pageProfile || null,
    globalProfile: globalProfile || existing.globalProfile || null,
  };
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
    mode: profile.mode === "dark" ? "dark" : "light",
    accent: typeof profile.accent === "string" && /^#[0-9a-fA-F]{6}$/.test(profile.accent) ? profile.accent : "",
    texture: profile.texture !== false,
    icon: icons.has(profile.icon) ? profile.icon : "✦",
    compact: profile.compact === true,
  };
}

function isMutualFriend(state, userId, otherId) {
  const user = state.users.find((candidate) => candidate.id === userId);
  const other = state.users.find((candidate) => candidate.id === otherId);
  return Boolean(user && other && user.friendIds.includes(otherId) && other.friendIds.includes(userId));
}

function canViewEntry(entry, viewerId, state) {
  if (entry.userId === viewerId) return true;
  if (entry.visibility === "public") return true;
  if (entry.visibility === "private") return false;
  if (!isMutualFriend(state, entry.userId, viewerId)) return false;
  const author = state.users.find((candidate) => candidate.id === entry.userId);
  if (author?.perFriendSettings?.[viewerId]?.canViewFriendOnlyPosts === false) return false;
  if (entry.visibility === "custom_friends" && !(entry.allowedFriendIds || []).includes(viewerId)) return false;
  return entry.visibility === "friends" || entry.visibility === "custom_friends";
}

function serializeEntry(entry, viewerId, state) {
  const author = state.users.find((user) => user.id === entry.userId);
  const anonymousToViewer = entry.isAnonymous && entry.userId !== viewerId;
  const comments = (entry.comments || []).map((comment) => {
    const hidden = comment.isAnonymous && comment.authorId !== viewerId;
    return {
      id: comment.id,
      authorId: hidden ? null : comment.authorId,
      authorName: hidden ? "Anonymous Writer" : comment.authorName,
      authorAvatar: hidden ? "" : (comment.authorAvatar || ""),
      isAnonymous: Boolean(comment.isAnonymous),
      text: comment.text,
      createdAt: comment.createdAt,
    };
  });
  const reactionTypes = ["resonance", "hug", "bookmark", "inspire"];
  const reactionUsers = entry.reactionUsers || {};
  const reactions = Object.fromEntries(reactionTypes.map((type) => [
    type,
    Array.isArray(reactionUsers[type])
      ? reactionUsers[type].length
      : Number(entry.reactions?.[type] || 0),
  ]));
  const userReactions = reactionTypes.filter((type) => (reactionUsers[type] || []).includes(viewerId));
  return {
    id: entry.id,
    title: entry.title || "",
    content: entry.content || "",
    authorId: anonymousToViewer ? null : entry.userId,
    authorName: anonymousToViewer ? "Anonymous Writer" : (author?.name || "Writer"),
    authorAvatar: anonymousToViewer ? "" : (author?.avatar || ""),
    isAnonymous: Boolean(entry.isAnonymous),
    anonymousAlias: entry.anonymousAlias || "",
    visibility: entry.visibility || "private",
    allowedFriendIds: entry.allowedFriendIds || [],
    excludedFriendIds: entry.excludedFriendIds || [],
    mood: entry.mood || "reflective",
    tags: entry.tags || [],
    location: entry.location || "",
    weather: entry.weather || null,
    photos: (entry.photoBlobs || []).map((photo) => ({
      id: photo.id,
      src: `/api/entries/${encodeURIComponent(entry.id)}/photos/${encodeURIComponent(photo.id)}`,
      alt: "Photo attached to diary entry",
    })),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    typingStats: entry.typingStats || { wpm: entry.wpm || 0, words: entry.words || 0, durationMinutes: 0, totalKeystrokes: 0 },
    privacySettings: {
      allowComments: entry.privacySettings?.allowComments !== false,
      allowReactions: entry.privacySettings?.allowReactions !== false,
      showTypingStats: entry.privacySettings?.showTypingStats === true,
    },
    reactions,
    userReactions,
    comments,
    isPinned: Boolean(entry.isPinned),
    pageProfile: entry.pageProfile || null,
    globalProfile: entry.globalProfile || null,
    seconds: entry.seconds || 0,
  };
}

function directoryUser(user) {
  return {
    id: user.id,
    username: user.username || usernameFromName(user.name),
    displayName: user.name,
    name: user.name,
    avatar: user.avatar || "",
    bio: user.bio || "",
    joinedDate: user.createdAt,
    defaultPrivacy: user.defaultPrivacy || "private",
    online: Date.now() - new Date(user.lastSeenAt || 0).getTime() < 5 * 60 * 1000,
  };
}

function validProfileSettings(value, current = {}) {
  if (!value || typeof value !== "object") return current;
  const soundTypes = new Set(["mechanical", "typewriter", "soft_click", "bubble", "retro_game", "rain_tap", "wood_block", "mute"]);
  const paperThemes = new Set(["parchment", "sepia", "midnight", "minimal"]);
  return {
    ...current,
    soundEnabled: value.soundEnabled !== undefined ? value.soundEnabled === true : current.soundEnabled !== false,
    soundType: soundTypes.has(value.soundType) ? value.soundType : (current.soundType || "mechanical"),
    paperTheme: paperThemes.has(value.paperTheme) ? value.paperTheme : (current.paperTheme || "parchment"),
    defaultAnonymous: value.defaultAnonymous !== undefined ? value.defaultAnonymous === true : current.defaultAnonymous === true,
    allowFriendRequests: value.allowFriendRequests !== undefined ? value.allowFriendRequests === true : current.allowFriendRequests !== false,
    showStatsByDefault: value.showStatsByDefault !== undefined ? value.showStatsByDefault === true : current.showStatsByDefault === true,
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
app.use(express.json({ limit: "3mb" }));
if (existsSync(frontendDist)) {
  app.use(express.static(frontendDist, { index: false }));
}

app.get("/", (_req, res) => {
  if (existsSync(frontendIndex)) return res.sendFile(frontendIndex);
  return res.send("Typing Diary API is live!");
});
app.get("/api/healthz", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/send-verification-code", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "Writer";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "Please enter a valid email address." });
  }

  const state = await getState();
  if (state.users.some((user) => user.email === email)) {
    return res.status(409).json({ error: "An account with that email already exists." });
  }

  const code = generateVerificationCode(email);
  try {
    const result = await sendVerificationEmail({ to: email, name, code });
    return res.json({
      success: true,
      message: result.sent
        ? `A 6-digit verification code has been sent to ${email}.`
        : `Verification code generated. (Configure SMTP/Resend in backend/.env to deliver to real inbox)`,
      realEmail: Boolean(result.sent),
      devCode: result.devMode ? result.code : undefined,
    });
  } catch (error) {
    console.error("Failed to send verification email:", error);
    return res.status(500).json({
      error: `Could not send verification email: ${error.message || "Email server error"}. Please check backend email configuration.`,
    });
  }
});

app.post("/api/auth/verify-code", async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";

  if (!email || !code) {
    return res.status(400).json({ error: "Email and verification code are required." });
  }

  const result = verifyCode(email, code);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  return res.json({ success: true, message: "Email verified successfully." });
});

app.post("/api/auth/register", async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const verificationCode = typeof req.body?.verificationCode === "string" ? req.body.verificationCode.trim() : "";
  const requestedUsername = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : usernameFromName(name);
  const bio = typeof req.body?.bio === "string" ? req.body.bio.trim().slice(0, 280) : "";

  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Please enter a name between 2 and 80 characters." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  if (password.length < 8) return res.status(400).json({ error: "Use a password with at least 8 characters." });
  if (!/^[a-z0-9_]{3,24}$/.test(requestedUsername)) return res.status(400).json({ error: "Username must be 3–24 characters using lowercase letters, numbers, or underscores." });

  if (!verificationCode) {
    return res.status(400).json({ error: "Email verification code is required. Please verify your email." });
  }

  const verifyResult = verifyCode(email, verificationCode);
  if (!verifyResult.success) {
    return res.status(400).json({ error: verifyResult.error });
  }

  const state = await getState();
  if (state.users.some((user) => user.email === email)) return res.status(409).json({ error: "An account with that email already exists." });
  if (state.users.some((user) => (user.username || usernameFromName(user.name)).toLowerCase() === requestedUsername)) return res.status(409).json({ error: "That username is already taken." });
  const { hash, salt } = hashPassword(password);
  const createdAt = new Date().toISOString();
  const user = {
    id: randomUUID(), name, username: requestedUsername, bio, email, passwordHash: hash, passwordSalt: salt, createdAt,
    avatar: "", defaultPrivacy: "private", friendIds: [], friendRequestsSent: [], friendRequestsReceived: [],
    perFriendSettings: {}, settings: validProfileSettings({}), lastSeenAt: createdAt,
  };
  await updateState((current) => current.users.push(user));
  setSession(res, user.id);
  return res.status(201).json({ user: publicUser(user) });
});

app.get("/api/auth/google/start", (req, res) => {
  const { GOOGLE_CLIENT_ID, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    const frontendUrl = (process.env.FRONTEND_URL || process.env.FRONTEND_ORIGIN || "http://localhost:5500").replace(/\/+$/, "");
    const destination = new URL("/", `${frontendUrl}/`);
    destination.searchParams.set("auth_error", "Google sign-in needs OAuth credentials configured in the backend environment.");
    return res.redirect(destination.toString());
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
          matched.defaultPrivacy ||= "private";
          matched.friendIds ||= [];
          matched.friendRequestsSent ||= [];
          matched.friendRequestsReceived ||= [];
          matched.perFriendSettings ||= {};
          matched.settings = validProfileSettings(matched.settings);
          matched.lastSeenAt = new Date().toISOString();
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
            defaultPrivacy: "private",
            friendIds: [],
            friendRequestsSent: [],
            friendRequestsReceived: [],
            perFriendSettings: {},
            settings: validProfileSettings({}),
            lastSeenAt: new Date().toISOString(),
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
  await updateState((current) => {
    const matched = current.users.find((candidate) => candidate.id === user.id);
    if (matched) matched.lastSeenAt = new Date().toISOString();
  });
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
  await updateState((current) => {
    const matched = current.users.find((candidate) => candidate.id === user.id);
    if (matched) matched.lastSeenAt = new Date().toISOString();
  });
  setSession(res, user.id);
  const refreshedUser = (await getState()).users.find((candidate) => candidate.id === user.id);
  return res.json({ user: publicUser(refreshedUser) });
});

app.patch("/api/profile", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const existing = state.users.find((candidate) => candidate.id === userId);
  if (!existing) return res.status(404).json({ error: "Account not found." });
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : existing.name;
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : existing.username;
  const bio = typeof req.body?.bio === "string" ? req.body.bio.trim() : (existing.bio || "");
  const defaultPrivacy = ["private", "friends", "custom_friends", "public"].includes(req.body?.defaultPrivacy)
    ? req.body.defaultPrivacy
    : existing.defaultPrivacy || "private";
  const avatar = typeof req.body?.avatar === "string" ? req.body.avatar.trim().slice(0, 1000) : existing.avatar || "";
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: "Display name must be 2–80 characters." });
  if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: "Username must be 3–24 characters using lowercase letters, numbers, or underscores." });
  if (bio.length > 280) return res.status(400).json({ error: "Bio must be 280 characters or fewer." });
  if (avatar && !/^https:\/\/[^\s]+$/i.test(avatar)) return res.status(400).json({ error: "Avatar URLs must start with https://." });

  if (state.users.some((user) => user.id !== userId && (user.username || usernameFromName(user.name)).toLowerCase() === username)) {
    return res.status(409).json({ error: "That username is already taken." });
  }
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    if (user) Object.assign(user, {
      name, username, bio, avatar, defaultPrivacy,
      settings: validProfileSettings(req.body?.settings, user.settings || {}),
    });
  });
  const updatedUser = (await getState()).users.find((user) => user.id === userId);
  return res.json({ user: publicUser(updatedUser) });
});

app.post("/api/presence", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const now = new Date().toISOString();
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    if (user) user.lastSeenAt = now;
  });
  return res.status(204).send();
});

app.get("/api/users", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const query = String(req.query.q || "").trim().toLowerCase().slice(0, 80);
  const currentUser = state.users.find((user) => user.id === userId);
  const users = state.users
    .filter((user) => user.id !== userId)
    .filter((user) => !query || [user.name, user.username, user.bio].some((value) => String(value || "").toLowerCase().includes(query)))
    .sort((a, b) => (b.lastSeenAt || "").localeCompare(a.lastSeenAt || ""))
    .slice(0, 200)
    .map(directoryUser);
  return res.json({ users, currentUser: currentUser ? publicUser(currentUser) : null });
});

app.post("/api/friends/requests", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const targetId = String(req.body?.userId || "").trim();
  const state = await getState();
  const sender = state.users.find((user) => user.id === userId);
  const target = state.users.find((user) => user.id === targetId);
  if (!sender) return res.status(404).json({ error: "Account not found." });
  if (!target || targetId === userId) return res.status(404).json({ error: "Writer not found." });
  if (sender.friendIds.includes(targetId)) return res.status(409).json({ error: "You are already friends." });
  if (target.settings?.allowFriendRequests === false) return res.status(403).json({ error: "This writer is not accepting friend requests." });
  if (target.friendRequestsSent.includes(userId)) {
    await updateState((current) => {
      const from = current.users.find((user) => user.id === targetId);
      const to = current.users.find((user) => user.id === userId);
      if (!from || !to) return;
      from.friendRequestsSent = from.friendRequestsSent.filter((id) => id !== userId);
      to.friendRequestsReceived = to.friendRequestsReceived.filter((id) => id !== targetId);
      from.friendIds = [...new Set([...from.friendIds, userId])];
      to.friendIds = [...new Set([...to.friendIds, targetId])];
    });
    return res.json({ accepted: true });
  }
  if (sender.friendRequestsSent.includes(targetId)) return res.json({ accepted: false });
  await updateState((current) => {
    const from = current.users.find((user) => user.id === userId);
    const to = current.users.find((user) => user.id === targetId);
    if (!from || !to) return;
    from.friendRequestsSent = [...new Set([...from.friendRequestsSent, targetId])];
    to.friendRequestsReceived = [...new Set([...to.friendRequestsReceived, userId])];
  });
  return res.status(201).json({ accepted: false });
});

app.post("/api/friends/requests/:userId/accept", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const requesterId = req.params.userId;
  let accepted = false;
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    const requester = current.users.find((candidate) => candidate.id === requesterId);
    if (!user || !requester || !user.friendRequestsReceived.includes(requesterId)) return;
    user.friendRequestsReceived = user.friendRequestsReceived.filter((id) => id !== requesterId);
    requester.friendRequestsSent = requester.friendRequestsSent.filter((id) => id !== userId);
    user.friendIds = [...new Set([...user.friendIds, requesterId])];
    requester.friendIds = [...new Set([...requester.friendIds, userId])];
    accepted = true;
  });
  return accepted ? res.json({ accepted: true }) : res.status(404).json({ error: "Friend request not found." });
});

app.delete("/api/friends/requests/:userId", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const otherId = req.params.userId;
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    const other = current.users.find((candidate) => candidate.id === otherId);
    if (!user || !other) return;
    user.friendRequestsReceived = user.friendRequestsReceived.filter((id) => id !== otherId);
    user.friendRequestsSent = user.friendRequestsSent.filter((id) => id !== otherId);
    other.friendRequestsReceived = other.friendRequestsReceived.filter((id) => id !== userId);
    other.friendRequestsSent = other.friendRequestsSent.filter((id) => id !== userId);
  });
  return res.status(204).send();
});

app.delete("/api/friends/:userId", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const otherId = req.params.userId;
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    const other = current.users.find((candidate) => candidate.id === otherId);
    if (!user || !other) return;
    user.friendIds = user.friendIds.filter((id) => id !== otherId);
    other.friendIds = other.friendIds.filter((id) => id !== userId);
    delete user.perFriendSettings[otherId];
    delete other.perFriendSettings[userId];
  });
  return res.status(204).send();
});

app.patch("/api/friends/:userId/settings", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const friendId = req.params.userId;
  const state = await getState();
  if (!isMutualFriend(state, userId, friendId)) return res.status(404).json({ error: "Friend not found." });
  await updateState((current) => {
    const user = current.users.find((candidate) => candidate.id === userId);
    if (!user) return;
    const previous = user.perFriendSettings[friendId] || {};
    user.perFriendSettings[friendId] = {
      ...previous,
      canViewFriendOnlyPosts: req.body?.canViewFriendOnlyPosts !== false,
      notificationsEnabled: req.body?.notificationsEnabled !== false,
    };
  });
  const user = (await getState()).users.find((candidate) => candidate.id === userId);
  return res.json({ settings: user?.perFriendSettings?.[friendId] || {} });
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
    if (user) user.settings = {
      ...validProfileSettings(user.settings),
      page: page || user.settings?.page || null,
      global: global || user.settings?.global || null,
      updatedAt: new Date().toISOString(),
    };
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
    .filter((entry) => canViewEntry(entry, userId, state))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((entry) => serializeEntry(entry, userId, state));
  return res.json({ entries });
});

app.get("/api/entries/:id/photos/:photoId", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id);
  if (!entry || !canViewEntry(entry, userId, state)) return res.status(404).json({ error: "Photo not found." });
  const photo = (entry.photoBlobs || []).find((candidate) => candidate.id === req.params.photoId);
  if (!photo) return res.status(404).json({ error: "Photo not found." });
  res.setHeader("Content-Type", photo.contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.send(Buffer.from(photo.data, "base64"));
});

app.post("/api/entries", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const input = normalizeEntry(req.body);
  if (input.error) return res.status(400).json(input);
  const state = await getState();
  input.allowedFriendIds = input.allowedFriendIds.filter((friendId) => isMutualFriend(state, userId, friendId));
  const now = new Date().toISOString();
  const entry = {
    ...input,
    id: randomUUID(),
    userId,
    reactionUsers: { resonance: [], hug: [], bookmark: [], inspire: [] },
    comments: [],
    createdAt: now,
    updatedAt: now,
  };
  await updateState((current) => current.entries.push(entry));
  const savedState = await getState();
  return res.status(201).json({ entry: serializeEntry(entry, userId, savedState) });
});

app.put("/api/entries/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id && candidate.userId === userId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  const input = normalizeEntry(req.body, entry);
  if (input.error) return res.status(400).json(input);
  input.allowedFriendIds = input.allowedFriendIds.filter((friendId) => isMutualFriend(state, userId, friendId));
  await updateState((current) => {
    const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
    Object.assign(currentEntry, input, { updatedAt: new Date().toISOString() });
  });
  return res.json({ entry: serializeEntry(entry, userId, await getState()) });
});

app.patch("/api/entries/:id", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id && candidate.userId === userId);
  if (!entry) return res.status(404).json({ error: "Entry not found." });
  const input = normalizeEntry(req.body, entry);
  if (input.error) return res.status(400).json(input);
  input.allowedFriendIds = input.allowedFriendIds.filter((friendId) => isMutualFriend(state, userId, friendId));
  await updateState((current) => {
    const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
    Object.assign(currentEntry, input, { updatedAt: new Date().toISOString() });
  });
  const refreshedState = await getState();
  const refreshedEntry = refreshedState.entries.find((candidate) => candidate.id === entry.id);
  return res.json({ entry: serializeEntry(refreshedEntry, userId, refreshedState) });
});

app.post("/api/entries/:id/comments", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
  if (!text || text.length > 3000) return res.status(400).json({ error: "Write a reflection up to 3,000 characters." });
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id);
  if (!entry || !canViewEntry(entry, userId, state)) return res.status(404).json({ error: "Entry not found." });
  if (entry.privacySettings?.allowComments === false) return res.status(403).json({ error: "Comments are disabled for this entry." });
  const author = state.users.find((candidate) => candidate.id === userId);
  const isAnonymous = req.body?.isAnonymous === true;
  const comment = {
    id: randomUUID(),
    authorId: userId,
    authorName: isAnonymous ? "Anonymous Writer" : (author?.name || "Writer"),
    authorAvatar: isAnonymous ? "" : (author?.avatar || ""),
    isAnonymous,
    text,
    createdAt: new Date().toISOString(),
  };
  await updateState((current) => {
    const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
    currentEntry.comments ||= [];
    currentEntry.comments.push(comment);
    currentEntry.updatedAt = new Date().toISOString();
  });
  const refreshedState = await getState();
  const refreshedEntry = refreshedState.entries.find((candidate) => candidate.id === entry.id);
  return res.status(201).json({ entry: serializeEntry(refreshedEntry, userId, refreshedState) });
});

app.post("/api/entries/:id/reactions", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const type = String(req.body?.type || "");
  const validTypes = new Set(["resonance", "hug", "bookmark", "inspire"]);
  if (!validTypes.has(type)) return res.status(400).json({ error: "Choose a supported reaction." });
  const state = await getState();
  const entry = state.entries.find((candidate) => candidate.id === req.params.id);
  if (!entry || !canViewEntry(entry, userId, state)) return res.status(404).json({ error: "Entry not found." });
  if (entry.privacySettings?.allowReactions === false) return res.status(403).json({ error: "Reactions are disabled for this entry." });
  await updateState((current) => {
    const currentEntry = current.entries.find((candidate) => candidate.id === entry.id);
    currentEntry.reactionUsers ||= { resonance: [], hug: [], bookmark: [], inspire: [] };
    const users = currentEntry.reactionUsers[type] ||= [];
    currentEntry.reactionUsers[type] = users.includes(userId)
      ? users.filter((id) => id !== userId)
      : [...users, userId];
    currentEntry.updatedAt = new Date().toISOString();
  });
  const refreshedState = await getState();
  const refreshedEntry = refreshedState.entries.find((candidate) => candidate.id === entry.id);
  return res.json({ entry: serializeEntry(refreshedEntry, userId, refreshedState) });
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

// DELETE /api/auth/me - Delete current logged-in user account and their entries
app.delete("/api/auth/me", async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;

  await updateState((current) => {
    // Remove the account's posts, comments, friend links, and pending requests.
    current.entries = current.entries.filter((entry) => entry.userId !== userId);
    for (const entry of current.entries) {
      entry.comments = (entry.comments || []).filter((comment) => comment.authorId !== userId);
      entry.allowedFriendIds = (entry.allowedFriendIds || []).filter((friendId) => friendId !== userId);
      for (const reactionType of ["resonance", "hug", "bookmark", "inspire"]) {
        const reactors = entry.reactionUsers?.[reactionType];
        if (Array.isArray(reactors)) {
          entry.reactionUsers[reactionType] = reactors.filter((reactorId) => reactorId !== userId);
          entry.reactions ||= {};
          entry.reactions[reactionType] = entry.reactionUsers[reactionType].length;
        }
      }
    }
    for (const user of current.users) {
      user.friendIds = (user.friendIds || []).filter((friendId) => friendId !== userId);
      user.friendRequestsSent = (user.friendRequestsSent || []).filter((requestId) => requestId !== userId);
      user.friendRequestsReceived = (user.friendRequestsReceived || []).filter((requestId) => requestId !== userId);
      if (user.perFriendSettings) delete user.perFriendSettings[userId];
    }
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

if (existsSync(frontendIndex)) {
  app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => res.sendFile(frontendIndex));
}

export default app;

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  const port = Number(process.env.PORT || process.env.API_PORT || 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid backend port: ${process.env.PORT || process.env.API_PORT}`);
  }
  app.listen(port, "0.0.0.0", () => {
    const servingFrontend = existsSync(frontendIndex);
    console.log(`Typing Diary ${servingFrontend ? "web app and API" : "API"} listening on port ${port}`);
  });
}