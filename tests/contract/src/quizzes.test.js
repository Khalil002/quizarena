import { describe, expect, it } from "vitest";
import { admin, api, createQuiz, expectProblem, registerUser, sampleQuiz } from "./client.js";

describe("quizzes", () => {
  it("validates questions", async () => {
    const { token } = await registerUser("author");
    const outOfRange = sampleQuiz({ questions: [{ prompt: "?", options: ["a", "b"], correctIndex: 2, timeLimitSec: 10 }] });
    expectProblem(await api("POST", "/quizzes", { token, body: outOfRange }), 400, "VALIDATION_ERROR");
    const oneOption = sampleQuiz({ questions: [{ prompt: "?", options: ["a"], correctIndex: 0, timeLimitSec: 10 }] });
    expectProblem(await api("POST", "/quizzes", { token, body: oneOption }), 400, "VALIDATION_ERROR");
    const tooFast = sampleQuiz({ questions: [{ prompt: "?", options: ["a", "b"], correctIndex: 0, timeLimitSec: 1 }] });
    expectProblem(await api("POST", "/quizzes", { token, body: tooFast }), 400, "VALIDATION_ERROR");
    expectProblem(await api("POST", "/quizzes", { token, body: { title: "x", questions: [] } }), 400, "VALIDATION_ERROR");
  });

  it("creates a quiz and lists it", async () => {
    const { token, user } = await registerUser("author");
    const quiz = await createQuiz(token);
    expect(quiz).toMatchObject({ ownerId: user.id, questions: sampleQuiz().questions });
    const list = await api("GET", "/quizzes", { token });
    expect(list.body.find((q) => q.id === quiz.id)).toMatchObject({ title: quiz.title, questionCount: 2, ownerId: user.id });
  });

  it("only shows answers to the owner or an admin", async () => {
    const owner = await registerUser("owner");
    const other = await registerUser("other");
    const quiz = await createQuiz(owner.token);
    expect((await api("GET", `/quizzes/${quiz.id}`, { token: owner.token })).status).toBe(200);
    expect((await api("GET", `/quizzes/${quiz.id}`, { token: await admin() })).status).toBe(200);
    expectProblem(await api("GET", `/quizzes/${quiz.id}`, { token: other.token }), 403, "FORBIDDEN");
    expectProblem(await api("GET", "/quizzes/not-a-uuid", { token: owner.token }), 404, "NOT_FOUND");
  });

  it("only lets the owner or an admin delete", async () => {
    const owner = await registerUser("owner");
    const other = await registerUser("other");
    const quiz = await createQuiz(owner.token);
    expectProblem(await api("DELETE", `/quizzes/${quiz.id}`, { token: other.token }), 403, "FORBIDDEN");
    expect((await api("DELETE", `/quizzes/${quiz.id}`, { token: owner.token })).status).toBe(204);
    expectProblem(await api("GET", `/quizzes/${quiz.id}`, { token: owner.token }), 404, "NOT_FOUND");

    const second = await createQuiz(owner.token);
    expect((await api("DELETE", `/quizzes/${second.id}`, { token: await admin() })).status).toBe(204);
  });
});
