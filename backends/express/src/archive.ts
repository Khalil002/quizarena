import { config } from "./config.js";
import { withTransaction } from "./db.js";
import { keys, redis } from "./redis.js";
import { rankOf } from "./domain/rules.js";

type StreamReply = [string, [string, string[]][]][] | null;

export async function ensureGroup(): Promise<void> {
  try {
    await redis.xgroup("CREATE", keys.archiveStream, keys.archiveGroup, "0", "MKSTREAM");
  } catch (err) {
    if (!String((err as Error).message).includes("BUSYGROUP")) throw err;
  }
}

/** Copies a finished room from Redis into match history. Idempotent by primary keys. */
export async function archiveMatch(matchId: string, code: string): Promise<void> {
  const room = await redis.hgetall(keys.room(code));
  if (room.matchId !== matchId) return; // expired or reused code: nothing to save
  const [names, scoreList, correct] = await Promise.all([
    redis.hgetall(keys.players(code)),
    redis.zrange(keys.scores(code), 0, -1, "WITHSCORES"),
    redis.hgetall(keys.correct(code)),
  ]);
  const scores = new Map<string, number>();
  for (let i = 0; i < scoreList.length; i += 2) scores.set(scoreList[i], Number(scoreList[i + 1]));
  const players = Object.entries(names).map(([userId, displayName]) => ({
    userId, displayName, score: scores.get(userId) ?? 0, correct: Number(correct[userId] ?? 0),
  }));
  const all = players.map((p) => p.score);

  await withTransaction(async (tx) => {
    await tx.query(
      `INSERT INTO matches (id, quiz_id, quiz_title, host_id, code, player_count)
       VALUES ($1, (SELECT id FROM quizzes WHERE id = $2), $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
      [matchId, room.quizId, room.quizTitle, room.hostId, code, players.length],
    );
    for (const p of players) {
      await tx.query(
        `INSERT INTO match_players (match_id, user_id, display_name, score, correct_count, rank)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
        [matchId, p.userId, p.displayName, p.score, p.correct, rankOf(p.score, all)],
      );
    }
  });
  await redis.del(keys.leaderboardCache);
}

/**
 * Consumer-group worker: first retries this consumer's own unacknowledged jobs ("0"),
 * then takes new ones (">"). A job is acknowledged only after its rows are committed.
 */
export async function archiveTick(): Promise<number> {
  let handled = 0;
  for (const id of ["0", ">"]) {
    const reply = (await redis.xreadgroup(
      "GROUP", keys.archiveGroup, config.consumerName, "COUNT", 10, "STREAMS", keys.archiveStream, id,
    )) as StreamReply;
    for (const [, entries] of reply ?? []) {
      for (const [entryId, fields] of entries) {
        const f: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2) f[fields[i]] = fields[i + 1];
        await archiveMatch(f.matchId, f.code);
        await redis.xack(keys.archiveStream, keys.archiveGroup, entryId);
        handled++;
      }
    }
  }
  return handled;
}

