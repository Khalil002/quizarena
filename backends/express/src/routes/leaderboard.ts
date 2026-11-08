import { Router } from "express";
import { config } from "../config.js";
import { pool } from "../db.js";
import { route } from "../http.js";
import { keys, redis } from "../redis.js";

export const leaderboardRouter = Router();

// Cache-aside: the aggregate query runs at most once per CACHE_TTL_SEC.
leaderboardRouter.get("/", route(async (_req, res) => {
  const cached = await redis.get(keys.leaderboardCache);
  if (cached) {
    res.set("X-Cache", "HIT").type("application/json").send(cached);
    return;
  }
  const { rows } = await pool.query(
    `SELECT mp.user_id AS "userId", u.display_name AS "displayName",
            SUM(mp.score)::int AS "totalScore", COUNT(*)::int AS matches
       FROM match_players mp JOIN users u ON u.id = mp.user_id
      GROUP BY mp.user_id, u.display_name
      ORDER BY "totalScore" DESC, u.display_name ASC LIMIT 10`,
  );
  const body = JSON.stringify(rows);
  await redis.set(keys.leaderboardCache, body, "EX", config.cacheTtlSec);
  res.set("X-Cache", "MISS").type("application/json").send(body);
}));
