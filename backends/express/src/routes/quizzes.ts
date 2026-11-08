import { Router, type Request } from "express";
import { pool, withTransaction } from "../db.js";
import { isUuid } from "../domain/rules.js";
import { newQuizSchema, type QuestionInput } from "../domain/schemas.js";
import { ApiError, notFound } from "../errors.js";
import { requireAuth } from "../auth.js";
import { parse, route } from "../http.js";

interface QuizRow { id: string; title: string; owner_id: string; created_at: Date }

export async function loadQuiz(id: string) {
  if (!isUuid(id)) return undefined;
  const quiz = await pool.query<QuizRow>("SELECT id, title, owner_id, created_at FROM quizzes WHERE id = $1", [id]);
  if (!quiz.rowCount) return undefined;
  const questions = await pool.query<QuestionInput>(
    `SELECT prompt, options, correct_index AS "correctIndex", time_limit_sec AS "timeLimitSec"
       FROM questions WHERE quiz_id = $1 ORDER BY position`, [id],
  );
  const q = quiz.rows[0];
  return { id: q.id, title: q.title, ownerId: q.owner_id, createdAt: q.created_at.toISOString(), questions: questions.rows };
}

/** Resource-level authorization: owners and admins only. */
async function ownedQuiz(req: Request) {
  const quiz = await loadQuiz(req.params.quizId);
  if (!quiz) throw notFound("Quiz");
  if (quiz.ownerId !== req.user!.id && req.user!.role !== "admin") {
    throw new ApiError(403, "FORBIDDEN", "Only the owner or an admin can do this");
  }
  return quiz;
}

export const quizzesRouter = Router();
quizzesRouter.use(requireAuth);

quizzesRouter.get("/", route(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT q.id, q.title, q.owner_id AS "ownerId", COUNT(qs.id)::int AS "questionCount", q.created_at AS "createdAt"
       FROM quizzes q LEFT JOIN questions qs ON qs.quiz_id = q.id
      GROUP BY q.id ORDER BY q.created_at DESC LIMIT 100`,
  );
  res.json(rows.map((r) => ({ ...r, createdAt: (r.createdAt as Date).toISOString() })));
}));

quizzesRouter.post("/", route(async (req, res) => {
  const input = parse(newQuizSchema, req.body);
  const id = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "INSERT INTO quizzes (owner_id, title) VALUES ($1, $2) RETURNING id", [req.user!.id, input.title],
    );
    for (const [position, q] of input.questions.entries()) {
      await tx.query(
        `INSERT INTO questions (quiz_id, position, prompt, options, correct_index, time_limit_sec)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [rows[0].id, position, q.prompt, q.options, q.correctIndex, q.timeLimitSec],
      );
    }
    return rows[0].id;
  });
  res.status(201).json(await loadQuiz(id));
}));

quizzesRouter.get("/:quizId", route(async (req, res) => {
  res.json(await ownedQuiz(req));
}));

quizzesRouter.delete("/:quizId", route(async (req, res) => {
  const quiz = await ownedQuiz(req);
  await pool.query("DELETE FROM quizzes WHERE id = $1", [quiz.id]);
  res.status(204).end();
}));
