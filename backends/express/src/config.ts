const num = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
};

const str = (name: string, fallback: string): string => process.env[name] || fallback;

export const config = {
  port: num("PORT", 8000),
  db: {
    host: str("DB_HOST", "localhost"),
    port: num("DB_PORT", 5432),
    database: str("DB_NAME", "quizarena"),
    user: str("DB_USER", "quizarena"),
    password: str("DB_PASSWORD", "quizarena"),
  },
  redis: { host: str("REDIS_HOST", "localhost"), port: num("REDIS_PORT", 6379) },
  jwtSecret: str("JWT_SECRET", "change-me-to-a-long-random-secret-of-32-bytes"),
  jwtTtlSec: num("JWT_TTL_SEC", 3600),
  roomTtlSec: num("ROOM_TTL_SEC", 21600),
  rateLimitMax: num("RATE_LIMIT_MAX", 10),
  rateLimitWindowSec: num("RATE_LIMIT_WINDOW_SEC", 60),
  cacheTtlSec: num("CACHE_TTL_SEC", 5),
  archiveIntervalMs: num("ARCHIVE_INTERVAL_MS", 1000),
  // Stable per container, so a restarted worker picks up its own unacknowledged jobs.
  consumerName: str("HOSTNAME", "local"),
};
