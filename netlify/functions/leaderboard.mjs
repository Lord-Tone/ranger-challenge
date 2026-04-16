import { getStore } from "@netlify/blobs";

const LEADERBOARD_LIMIT = 20;
const STORE_NAME = "ranger-challenge";
const SCORE_KEY = "leaderboard-v1";
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
  return a.createdAt - b.createdAt;
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

async function readEntries() {
  const store = getLeaderboardStore();
  const data = await store.get(SCORE_KEY, { type: "json", consistency: "strong" });
  if (!Array.isArray(data)) return [];
  return data.map(normalizeEntry).sort(compareScores).slice(0, LEADERBOARD_LIMIT);
}

async function writeEntries(entries) {
  const store = getLeaderboardStore();
  const normalized = entries.map(normalizeEntry).sort(compareScores).slice(0, LEADERBOARD_LIMIT);
  await store.setJSON(SCORE_KEY, normalized);
  return normalized;
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
      return jsonResponse({ entries, mode: "online" });
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

      const entries = await readEntries();
      entries.push({
        name,
        stars,
        level,
        createdAt: Date.now()
      });

      const updated = await writeEntries(entries);
      return jsonResponse({ entries: updated, mode: "online" }, 201);
    }

    return jsonResponse({ error: "Method not allowed" }, 405);
  } catch (err) {
    return jsonResponse({ error: "Leaderboard request failed" }, 500);
  }
};
