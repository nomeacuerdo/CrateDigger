import { RateLimiter } from "./rate-limiter.js";

const USER_AGENT = "CrateDigger/1.0 (personal collection tracker)";
const BASE = process.env.DISCOGS_API_BASE ?? "https://api.discogs.com";
const MAX_NETWORK_ATTEMPTS = 5;
const MAX_REQUESTS = process.env.MAX_REQUESTS || 24;

export const rateLimiter = new RateLimiter({
  maxRequests: MAX_REQUESTS,
  windowMs: 60_000,
});

rateLimiter.successes = 0;

// True when the path is a full URL, otherwise it's treated as API-relative.
const isAbsolute = (path) => /^https?:\/\//.test(path);

// Performs one Discogs request: rate-limited, retried on network errors and 429s, returns parsed JSON.
export async function request(path) {
  const url = isAbsolute(path) ? path : `${BASE}${path}`;
  const headers = {
    "User-Agent": USER_AGENT,
    Authorization: `Discogs token=${process.env.DISCOGS_TOKEN}`,
  };

  let attempts = 0;
  for (;;) {
    await rateLimiter.acquire();
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      attempts++;
      if (attempts >= MAX_NETWORK_ATTEMPTS) {
        throw new Error(`Network error after ${attempts} attempts: ${err.message}`);
      }
      await rateLimiter.block(5);
      continue;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get("retry-after") ?? "60", 10) || 60;
      await rateLimiter.block(retryAfter);
      continue;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Discogs ${res.status} for ${path}: ${body.slice(0, 200)}`);
    }

    rateLimiter.successes++;
    return res.json();
  }
}