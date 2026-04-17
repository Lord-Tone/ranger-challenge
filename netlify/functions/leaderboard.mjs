import { getStore } from "@netlify/blobs";

const LATEST_LIMIT = 5;
const STORE_NAME = "ranger-challenge";
const SCORE_KEY = "leaderboard-v1";
const LATEST_KEY = "leaderboard-latest-v1";
const SUBMISSION_KEY = "leaderboard-submissions-v1";
const RATE_LIMIT_MS = 15000;
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const JSON_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

function getLeaderboardStore() {
  return getStore(STORE_NAME);
}

function compareScores(a, b) {
  if (b.stars !== a.stars) return b.stars - a.stars;
  if (b.level !== a.level) return b.level - a.level;
  return b.createdAt - a.createdAt;
}

function sanitizeName(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 10);
}

function normalizeEntry(entry) {
  return {
    name: sanitizeName(entry && entry.name) || "RANGER",
    stars: Math.max(0, Number(entry && entry.stars) || 0),
    level: Math.max(1, Number(entry && entry.level) || 1),
    createdAt: Number(entry && entry.createdAt) || Date.now()
  };
}

function getClientIp(req) {
  const raw = req.headers.get("x-nf-client-connection-ip") || req.headers.get("x-forwarded-for") || "unknown";
  return String(raw).split(",")[0].trim().replace(/[^a-fA-F0-9:.]/g, "") || "unknown";
}

function rateKeyForIp(ip) {
  return `leaderboard-rate-${ip}`;
}

async function readEntries() {
  const store = getLeaderboardStore();
  const data = await store.get(SCORE_KEY, { type: "json", consistency: "strong" });
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntry).sort(compareScores);
}

async function writeEntries(entries) {
  const store = getLeaderboardStore();
  const normalized = entries.map(normalizeEntry).sort(compareScores);
  await store.setJSON(SCORE_KEY, normalized);
  return normalized;
}

async function readLatest() {
  const store = getLeaderboardStore();
  const data = await store.get(LATEST_KEY, { type: "json", consistency: "strong" });
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, LATEST_LIMIT);
}

async function writeLatest(entries) {
  const store = getLeaderboardStore();
  const normalized = entries.map(normalizeEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, LATEST_LIMIT);
  await store.setJSON(LATEST_KEY, normalized);
  return normalized;
}

async function readRecentSubmissions() {
  const store = getLeaderboardStore();
  const data = await store.get(SUBMISSION_KEY, { type: "json", consistency: "strong" });
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
}

async function writeRecentSubmissions(entries) {
  const store = getLeaderboardStore();
  const normalized = entries.map(normalizeEntry).sort((a, b) => b.createdAt - a.createdAt).slice(0, 80);
  await store.setJSON(SUBMISSION_KEY, normalized);
  return normalized;
}

async function isRateLimited(ip) {
  const store = getLeaderboardStore();
  const lastSubmission = await store.get(rateKeyForIp(ip), { type: "json", consistency: "strong" });
  const lastAt = Number(lastSubmission && lastSubmission.at) || 0;
  if (Date.now() - lastAt < RATE_LIMIT_MS) return true;
  await store.setJSON(rateKeyForIp(ip), { at: Date.now() });
  return false;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: JSON_HEADERS
  });
}

export default async (req) => {
  try {
    if (req.method === "GET") {
      const entries = await readEntries();
      const latest = await readLatest();
      return jsonResponse({ entries, latest, mode: "online" });
    }

    if (req.method === "POST") {
      let payload;
      try {
        payload = await req.json();
      } catch (err) {
        return jsonResponse({ error: "Invalid JSON body" }, 400);
      }

      const name = sanitizeName(payload && payload.name);
      const stars = Math.max(0, Number(payload && payload.stars) || 0);
      const level = Math.max(1, Number(payload && payload.level) || 1);

      if (!name) {
        return jsonResponse({ error: "Name is required" }, 400);
      }

      const ip = getClientIp(req);
      if (await isRateLimited(ip)) {
        return jsonResponse({ error: "Please wait a few seconds before submitting another score." }, 429);
      }

      const entries = await readEntries();
      const submission = {
        name,
        stars,
        level,
        createdAt: Date.now()
      };
      const recentSubmissions = await readRecentSubmissions();
      const duplicate = recentSubmissions.find(entry =>
        entry.name === submission.name &&
        entry.stars === submission.stars &&
        entry.level === submission.level &&
        Math.abs((submission.createdAt || 0) - (entry.createdAt || 0)) < DUPLICATE_WINDOW_MS
      );
      if (duplicate) {
        return jsonResponse({ error: "That exact score is already on the board recently." }, 409);
      }

      entries.push(submission);
      const updated = await writeEntries(entries);
      const latest = await writeLatest([submission, ...(await readLatest())]);
      await writeRecentSubmissions([submission, ...recentSubmissions]);
      return jsonResponse({ entries: updated, latest, mode: "online" }, 201);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (err) {
    return jsonResponse({ error: "Leaderboard request failed" }, 500);
  }
};
