import { config } from "./config.js";
import { ApiError, notFound } from "./errors.js";
import { keys, redis } from "./redis.js";
import { CODE_RE, points, roomCode, sortPlayers } from "./domain/rules.js";
import type { AuthUser } from "./auth.js";

/**
 * The live game lives in Redis, so any instance (of any backend) can serve any room.
 *   qa:room:{code}            hash  matchId, quizId, quizTitle, hostId, state, questionIndex, questionStartedAt, quiz
 *   qa:room:{code}:players    hash  userId -> displayName
 *   qa:room:{code}:scores     zset  userId -> score
 *   qa:room:{code}:correct    hash  userId -> correct answers
 *   qa:room:{code}:answers:i  hash  userId -> optionIndex (HSETNX = one answer each)
 */

export type RoomState = "lobby" | "question" | "reveal" | "finished";
interface StoredQuestion { prompt: string; options: string[]; correctIndex: number; timeLimitSec: number }
interface RoomMeta {
  matchId: string; quizId: string; quizTitle: string; hostId: string; state: RoomState;
  questionIndex: number; questionStartedAt: number; quiz: StoredQuestion[];
}

async function load(code: string): Promise<RoomMeta> {
  const h = CODE_RE.test(code) ? await redis.hgetall(keys.room(code)) : {};
  if (!h.matchId) throw notFound("Room");
  return {
    matchId: h.matchId, quizId: h.quizId, quizTitle: h.quizTitle, hostId: h.hostId, state: h.state as RoomState,
    questionIndex: Number(h.questionIndex), questionStartedAt: Number(h.questionStartedAt), quiz: JSON.parse(h.quiz),
  };
}

const roomKeys = (code: string, questionCount: number) => [
  keys.room(code), keys.players(code), keys.scores(code), keys.correct(code),
  ...Array.from({ length: questionCount }, (_, i) => keys.answers(code, i)),
];

async function touch(code: string, questionCount: number): Promise<void> {
  const pipeline = redis.pipeline();
  for (const key of roomKeys(code, questionCount)) pipeline.expire(key, config.roomTtlSec);
  await pipeline.exec();
}

/** The public view of a room; correct answers appear only once revealed. */
export async function view(code: string, meta?: RoomMeta) {
  const m = meta ?? (await load(code));
  const [names, scoreList] = await Promise.all([
    redis.hgetall(keys.players(code)),
    redis.zrange(keys.scores(code), 0, -1, "WITHSCORES"),
  ]);
  const scores = new Map<string, number>();
  for (let i = 0; i < scoreList.length; i += 2) scores.set(scoreList[i], Number(scoreList[i + 1]));
  const players = sortPlayers(Object.entries(names).map(([userId, displayName]) => ({
    userId, displayName, score: scores.get(userId) ?? 0,
  })));

  const open = m.state === "question" || m.state === "reveal";
  const q = open ? m.quiz[m.questionIndex] : undefined;
  const answeredCount = open ? await redis.hlen(keys.answers(code, m.questionIndex)) : 0;
  return {
    code,
    matchId: m.matchId,
    quizId: m.quizId,
    quizTitle: m.quizTitle,
    hostId: m.hostId,
    state: m.state,
    questionIndex: m.questionIndex,
    questionCount: m.quiz.length,
    question: q ? {
      index: m.questionIndex,
      prompt: q.prompt,
      options: q.options,
      timeLimitSec: q.timeLimitSec,
      deadline: new Date(m.questionStartedAt + q.timeLimitSec * 1000).toISOString(),
      correctIndex: m.state === "reveal" ? q.correctIndex : null,
    } : null,
    answeredCount,
    players,
  };
}

/** Pushes the new state to every WebSocket, on every instance, via Redis pub/sub. */
async function broadcast(code: string, meta?: RoomMeta) {
  const room = await view(code, meta);
  await redis.publish(keys.events(code), JSON.stringify(room));
  return room;
}

export async function createRoom(host: AuthUser, quizId: string, quizTitle: string, quiz: StoredQuestion[]) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = roomCode();
    // HSETNX on matchId claims the code atomically.
    if (!(await redis.hsetnx(keys.room(code), "matchId", crypto.randomUUID()))) continue;
    await redis.hset(keys.room(code), {
      quizId, quizTitle, hostId: host.id, state: "lobby", questionIndex: -1, questionStartedAt: 0, quiz: JSON.stringify(quiz),
    });
    await touch(code, quiz.length);
    return view(code);
  }
  throw new Error("could not allocate a room code");
}

export async function join(code: string, user: AuthUser) {
  const m = await load(code);
  if (m.hostId === user.id) throw new ApiError(409, "HOST_CANNOT_JOIN", "The host runs the game and cannot play");
  if (await redis.hexists(keys.players(code), user.id)) return view(code, m);
  if (m.state !== "lobby") throw new ApiError(409, "ROOM_STARTED", "This game has already started");
  await redis.hset(keys.players(code), user.id, user.displayName);
  await redis.zadd(keys.scores(code), "NX", 0, user.id);
  await touch(code, m.quiz.length);
  return broadcast(code, m);
}

function requireHost(m: RoomMeta, user: AuthUser) {
  if (m.hostId !== user.id) throw new ApiError(403, "NOT_HOST", "Only the host can do this");
}

export async function start(code: string, user: AuthUser) {
  const m = await load(code);
  requireHost(m, user);
  if (m.state !== "lobby") throw new ApiError(409, "ROOM_STARTED", "This game has already started");
  if ((await redis.hlen(keys.players(code))) === 0) throw new ApiError(409, "NO_PLAYERS", "Wait for at least one player");
  return openQuestion(code, m, 0);
}

async function openQuestion(code: string, m: RoomMeta, index: number) {
  const startedAt = Date.now();
  await redis.hset(keys.room(code), { state: "question", questionIndex: index, questionStartedAt: startedAt });
  return broadcast(code, { ...m, state: "question", questionIndex: index, questionStartedAt: startedAt });
}

export async function next(code: string, user: AuthUser) {
  const m = await load(code);
  requireHost(m, user);
  switch (m.state) {
    case "lobby":
      throw new ApiError(409, "ROOM_NOT_STARTED", "Start the game first");
    case "finished":
      throw new ApiError(409, "ROOM_FINISHED", "This game is over");
    case "question":
      await redis.hset(keys.room(code), "state", "reveal");
      return broadcast(code, { ...m, state: "reveal" });
    case "reveal":
      if (m.questionIndex + 1 < m.quiz.length) return openQuestion(code, m, m.questionIndex + 1);
      await redis.hset(keys.room(code), "state", "finished");
      // Hand the result to the archive worker (any instance) through a Redis stream.
      await redis.xadd(keys.archiveStream, "*", "matchId", m.matchId, "code", code);
      return broadcast(code, { ...m, state: "finished" });
  }
}

export async function answer(code: string, user: AuthUser, questionIndex: number, optionIndex: number) {
  const m = await load(code);
  if (!(await redis.hexists(keys.players(code), user.id))) {
    throw new ApiError(403, "NOT_A_PLAYER", "Join the room before answering");
  }
  const q = m.quiz[questionIndex];
  const elapsed = Date.now() - m.questionStartedAt;
  if (m.state !== "question" || questionIndex !== m.questionIndex || !q || elapsed > q.timeLimitSec * 1000) {
    throw new ApiError(409, "QUESTION_CLOSED", "That question is not open for answers");
  }
  if (optionIndex >= q.options.length) {
    throw new ApiError(400, "VALIDATION_ERROR", "Request validation failed", "optionIndex: out of range");
  }
  if (!(await redis.hsetnx(keys.answers(code, questionIndex), user.id, String(optionIndex)))) {
    throw new ApiError(409, "ALREADY_ANSWERED", "You already answered this question");
  }
  const earned = points(optionIndex === q.correctIndex, elapsed, q.timeLimitSec);
  if (earned > 0) {
    await redis.zincrby(keys.scores(code), earned, user.id);
    await redis.hincrby(keys.correct(code), user.id, 1);
  }
  await touch(code, m.quiz.length);
  await broadcast(code, m);
  return { accepted: true };
}
