import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, points, rankOf, rateWindow, roomCode, sortPlayers } from "../src/domain/rules.js";
import { newQuizSchema, registrationSchema } from "../src/domain/schemas.js";

describe("points", () => {
  it("pays 500 for a correct answer plus up to 500 for speed", () => {
    expect(points(true, 0, 10)).toBe(1000);
    expect(points(true, 5_000, 10)).toBe(750);
    expect(points(true, 2_500, 20)).toBe(937);
    expect(points(true, 10_000, 10)).toBe(500);
    expect(points(true, 12_000, 10)).toBe(500);
    expect(points(true, -50, 10)).toBe(1000);
  });
  it("pays nothing for a wrong answer", () => {
    expect(points(false, 0, 10)).toBe(0);
  });
});

describe("roomCode", () => {
  it("draws six characters from the unambiguous alphabet", () => {
    expect(roomCode(() => 0)).toBe("AAAAAA");
    expect(roomCode(() => CODE_ALPHABET.length - 1)).toBe("999999");
    expect(roomCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe("ordering and ranking", () => {
  it("sorts by score, then name, then id", () => {
    const sorted = sortPlayers([
      { userId: "b", displayName: "Zed", score: 10 },
      { userId: "c", displayName: "Amy", score: 10 },
      { userId: "a", displayName: "Amy", score: 10 },
      { userId: "d", displayName: "Bob", score: 900 },
    ]);
    expect(sorted.map((p) => p.userId)).toEqual(["d", "a", "c", "b"]);
  });
  it("gives tied scores the same rank", () => {
    const all = [900, 500, 500, 0];
    expect(all.map((s) => rankOf(s, all))).toEqual([1, 2, 2, 4]);
  });
});

describe("rateWindow", () => {
  it("buckets time into fixed windows", () => {
    expect(rateWindow(120_000, 60)).toEqual({ window: 2, retryAfterSec: 60 });
    expect(rateWindow(179_500, 60)).toEqual({ window: 2, retryAfterSec: 1 });
  });
});

describe("schemas", () => {
  it("trims display names and lowercases emails", () => {
    expect(registrationSchema.parse({ email: "A@B.io", password: "password1", displayName: " Ada " }))
      .toMatchObject({ email: "a@b.io", displayName: "Ada" });
  });
  it("rejects a correct index past the options", () => {
    const quiz = { title: "t", questions: [{ prompt: "p", options: ["a", "b"], correctIndex: 2, timeLimitSec: 10 }] };
    expect(newQuizSchema.safeParse(quiz).success).toBe(false);
    quiz.questions[0].correctIndex = 1;
    expect(newQuizSchema.safeParse(quiz).success).toBe(true);
  });
});
