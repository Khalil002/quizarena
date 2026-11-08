import { describe, expect, it } from "vitest";
import {
  api, createQuiz, eventually, expectProblem, RATE_LIMIT_MAX, registerUser, roomWithPlayers,
} from "./client.js";

const post = (path, token, body) => api("POST", path, { token, body });

describe("rooms", () => {
  it("opens a lobby for a quiz", async () => {
    const host = await registerUser("host");
    const quiz = await createQuiz(host.token);
    const res = await post("/rooms", host.token, { quizId: quiz.id });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[A-Z2-9]{6}$/);
    expect(res.body).toMatchObject({
      quizId: quiz.id, quizTitle: quiz.title, hostId: host.user.id, state: "lobby",
      questionIndex: -1, questionCount: 2, question: null, answeredCount: 0, players: [],
    });
    expectProblem(await post("/rooms", host.token, { quizId: "00000000-0000-0000-0000-00000000ffff" }), 404, "NOT_FOUND");
    expectProblem(await post("/rooms", host.token, { quizId: "nope" }), 400, "VALIDATION_ERROR");
  });

  it("lets players join once and keeps the host out", async () => {
    const { host, room, players } = await roomWithPlayers(1);
    const again = await post(`/rooms/${room.code}/join`, players[0].token);
    expect(again.status).toBe(200);
    expect(again.body.players).toEqual([{ userId: players[0].user.id, displayName: "p0", score: 0 }]);
    expectProblem(await post(`/rooms/${room.code}/join`, host.token), 409, "HOST_CANNOT_JOIN");
    expectProblem(await post("/rooms/ZZZZZZ/join", host.token), 404, "NOT_FOUND");
    expectProblem(await api("GET", "/rooms/lower1", { token: host.token }), 404, "NOT_FOUND");
  });

  it("only the host can start, and only with players", async () => {
    const host = await registerUser("host");
    const quiz = await createQuiz(host.token);
    const room = (await post("/rooms", host.token, { quizId: quiz.id })).body;
    expectProblem(await post(`/rooms/${room.code}/start`, host.token), 409, "NO_PLAYERS");
    expectProblem(await post(`/rooms/${room.code}/next`, host.token), 409, "ROOM_NOT_STARTED");
    const player = await registerUser("pl");
    await post(`/rooms/${room.code}/join`, player.token);
    expectProblem(await post(`/rooms/${room.code}/start`, player.token), 403, "NOT_HOST");
    const started = await post(`/rooms/${room.code}/start`, host.token);
    expect(started.status).toBe(200);
    expect(started.body.state).toBe("question");
    const late = await registerUser("late");
    expectProblem(await post(`/rooms/${room.code}/join`, late.token), 409, "ROOM_STARTED");
    expectProblem(await post(`/rooms/${room.code}/start`, host.token), 409, "ROOM_STARTED");
  });

  it("plays a full game with server-side scoring and archives it", async () => {
    const { host, room, players: [fast, wrong] } = await roomWithPlayers(2);
    const code = room.code;

    const q0 = (await post(`/rooms/${code}/start`, host.token)).body;
    expect(q0.question).toMatchObject({ index: 0, prompt: "2 + 2?", options: ["3", "4", "5"], timeLimitSec: 30, correctIndex: null });
    expect(new Date(q0.question.deadline).getTime()).toBeGreaterThan(Date.now());

    expect((await post(`/rooms/${code}/answer`, fast.token, { questionIndex: 0, optionIndex: 1 })).body).toEqual({ accepted: true });
    expect((await post(`/rooms/${code}/answer`, wrong.token, { questionIndex: 0, optionIndex: 0 })).status).toBe(200);
    expectProblem(await post(`/rooms/${code}/answer`, fast.token, { questionIndex: 0, optionIndex: 1 }), 409, "ALREADY_ANSWERED");
    expectProblem(await post(`/rooms/${code}/answer`, host.token, { questionIndex: 0, optionIndex: 1 }), 403, "NOT_A_PLAYER");
    expectProblem(await post(`/rooms/${code}/answer`, wrong.token, { questionIndex: 1, optionIndex: 0 }), 409, "QUESTION_CLOSED");
    expectProblem(await post(`/rooms/${code}/next`, fast.token), 403, "NOT_HOST");

    const reveal = (await post(`/rooms/${code}/next`, host.token)).body;
    expect(reveal).toMatchObject({ state: "reveal", answeredCount: 2, question: { correctIndex: 1 } });
    const [first, second] = reveal.players;
    expect(first.userId).toBe(fast.user.id);
    expect(first.score).toBeGreaterThanOrEqual(900); // answered within a few seconds of 30
    expect(first.score).toBeLessThanOrEqual(1000);
    expect(second).toMatchObject({ userId: wrong.user.id, score: 0 });
    expectProblem(await post(`/rooms/${code}/answer`, wrong.token, { questionIndex: 0, optionIndex: 1 }), 409, "QUESTION_CLOSED");

    const q1 = (await post(`/rooms/${code}/next`, host.token)).body;
    expect(q1).toMatchObject({ state: "question", questionIndex: 1, answeredCount: 0 });
    expectProblem(await post(`/rooms/${code}/answer`, wrong.token, { questionIndex: 1, optionIndex: 5 }), 400, "VALIDATION_ERROR");
    await post(`/rooms/${code}/answer`, wrong.token, { questionIndex: 1, optionIndex: 1 });
    await post(`/rooms/${code}/next`, host.token);
    const done = (await post(`/rooms/${code}/next`, host.token)).body;
    expect(done).toMatchObject({ state: "finished", question: null });
    expectProblem(await post(`/rooms/${code}/next`, host.token), 409, "ROOM_FINISHED");

    // The archive worker copies the result into PostgreSQL in the background.
    const history = await eventually(async () => {
      const res = await api("GET", "/me/matches", { token: fast.token });
      return res.body.find((m) => m.matchId === room.matchId);
    });
    expect(history).toMatchObject({ code, quizTitle: room.quizTitle, score: first.score, correctCount: 1, rank: 1, playerCount: 2 });
    const loser = (await api("GET", "/me/matches", { token: wrong.token })).body.find((m) => m.matchId === room.matchId);
    expect(loser).toMatchObject({ score: 0, correctCount: 0, rank: 2 });
  });

  it("closes questions at the server-side deadline", async () => {
    const { host, room, players: [p] } = await roomWithPlayers(1, {
      questions: [{ prompt: "Quick!", options: ["a", "b"], correctIndex: 0, timeLimitSec: 5 }],
    });
    await post(`/rooms/${room.code}/start`, host.token);
    await new Promise((r) => setTimeout(r, 5_300));
    expectProblem(await post(`/rooms/${room.code}/answer`, p.token, { questionIndex: 0, optionIndex: 0 }), 409, "QUESTION_CLOSED");
  });

  it("rate limits hosting per user", async () => {
    const host = await registerUser("spammer");
    const quiz = await createQuiz(host.token);
    const results = await Promise.all(
      Array.from({ length: RATE_LIMIT_MAX + 3 }, () => post("/rooms", host.token, { quizId: quiz.id })),
    );
    const limited = results.filter((r) => r.status === 429);
    expect(limited.length).toBeGreaterThan(0);
    expectProblem(limited[0], 429, "RATE_LIMITED");
    expect(Number(limited[0].headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
  });
});

describe("leaderboard", () => {
  it("is served from cache on repeat reads", async () => {
    await api("GET", "/leaderboard");
    const res = await api("GET", "/leaderboard");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.headers.get("x-cache")).toBe("HIT");
    for (const row of res.body) expect(Object.keys(row).sort()).toEqual(["displayName", "matches", "totalScore", "userId"]);
  });
});
