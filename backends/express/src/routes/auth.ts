import { Router } from "express";
import bcrypt from "bcryptjs";
import { isUniqueViolation, pool } from "../db.js";
import { registrationSchema } from "../domain/schemas.js";
import { ApiError, notFound } from "../errors.js";
import { issueToken, requireAuth, type AuthUser } from "../auth.js";
import { parse, route } from "../http.js";

const USER_COLUMNS = `id, email, display_name AS "displayName", role`;

export const authRouter = Router();

authRouter.post("/register", route(async (req, res) => {
  const { email, password, displayName } = parse(registrationSchema, req.body);
  try {
    const { rows } = await pool.query<AuthUser>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, $3) RETURNING ${USER_COLUMNS}`,
      [email, displayName, await bcrypt.hash(password, 10)],
    );
    res.status(201).json({ token: issueToken(rows[0]), user: rows[0] });
  } catch (err) {
    if (isUniqueViolation(err)) throw new ApiError(409, "EMAIL_TAKEN", "Email is already registered");
    throw err;
  }
}));

authRouter.post("/login", route(async (req, res) => {
  const body = (req.body ?? {}) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const { rows } = await pool.query<AuthUser & { password_hash: string }>(
    `SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email) = $1`, [email],
  );
  const found = rows[0];
  if (!found || !(await bcrypt.compare(password, found.password_hash))) {
    throw new ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect");
  }
  const { password_hash: _, ...user } = found;
  res.json({ token: issueToken(user), user });
}));

export const meRouter = Router();
meRouter.use(requireAuth);

meRouter.get("/", route(async (req, res) => {
  const { rows } = await pool.query(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [req.user!.id]);
  if (!rows[0]) throw notFound("User");
  res.json(rows[0]);
}));

meRouter.get("/matches", route(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT m.id AS "matchId", m.quiz_title AS "quizTitle", m.code, mp.score, mp.correct_count AS "correctCount",
            mp.rank, m.player_count AS "playerCount", m.finished_at AS "finishedAt"
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.user_id = $1 ORDER BY m.finished_at DESC LIMIT 50`,
    [req.user!.id],
  );
  res.json(rows.map((r) => ({ ...r, finishedAt: (r.finishedAt as Date).toISOString() })));
}));
