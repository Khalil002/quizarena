import { Redis } from "ioredis";
import { config } from "./config.js";

const options = { host: config.redis.host, port: config.redis.port, maxRetriesPerRequest: 3 };
export const redis = new Redis(options);
/** Pub/sub needs its own connection. */
export const subscriber = new Redis(options);

/** Redis key names shared by all three backends. */
export const keys = {
  room: (code: string) => `qa:room:${code}`,
  players: (code: string) => `qa:room:${code}:players`,
  scores: (code: string) => `qa:room:${code}:scores`,
  correct: (code: string) => `qa:room:${code}:correct`,
  answers: (code: string, index: number) => `qa:room:${code}:answers:${index}`,
  events: (code: string) => `qa:events:${code}`,
  eventsPattern: "qa:events:*",
  archiveStream: "qa:stream:archive",
  archiveGroup: "archivers",
  leaderboardCache: "qa:cache:leaderboard",
  rateLimit: (userId: string, window: number) => `qa:rl:${userId}:${window}`,
};
