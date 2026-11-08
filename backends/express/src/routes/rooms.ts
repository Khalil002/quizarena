import { Router, type NextFunction, type Request, type Response } from "express";
import { config } from "../config.js";
import { answerSchema, newRoomSchema } from "../domain/schemas.js";
import { rateWindow } from "../domain/rules.js";
import { ApiError, notFound } from "../errors.js";
import { requireAuth } from "../auth.js";
import { parse, route } from "../http.js";
import { keys, redis } from "../redis.js";
import * as rooms from "../rooms.js";
import { loadQuiz } from "./quizzes.js";

/** Per-user fixed-window limit on hosting rooms. */
async function rateLimit(req: Request, _res: Response, next: NextFunction): Promise<void> {
  try {
    const { window, retryAfterSec } = rateWindow(Date.now(), config.rateLimitWindowSec);
    const key = keys.rateLimit(req.user!.id, window);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, config.rateLimitWindowSec);
    if (count > config.rateLimitMax) {
      return next(new ApiError(429, "RATE_LIMITED", "Too many rooms, slow down", undefined, {
        "Retry-After": String(retryAfterSec),
      }));
    }
    next();
  } catch (err) {
    next(err);
  }
}

export const roomsRouter = Router();
roomsRouter.use(requireAuth);

roomsRouter.post("/", rateLimit, route(async (req, res) => {
  const { quizId } = parse(newRoomSchema, req.body);
  const quiz = await loadQuiz(quizId);
  if (!quiz) throw notFound("Quiz");
  res.status(201).json(await rooms.createRoom(req.user!, quiz.id, quiz.title, quiz.questions));
}));

roomsRouter.get("/:code", route(async (req, res) => {
  res.json(await rooms.view(req.params.code));
}));

roomsRouter.post("/:code/join", route(async (req, res) => {
  res.json(await rooms.join(req.params.code, req.user!));
}));

roomsRouter.post("/:code/start", route(async (req, res) => {
  res.json(await rooms.start(req.params.code, req.user!));
}));

roomsRouter.post("/:code/next", route(async (req, res) => {
  res.json(await rooms.next(req.params.code, req.user!));
}));

roomsRouter.post("/:code/answer", route(async (req, res) => {
  const { questionIndex, optionIndex } = parse(answerSchema, req.body);
  res.json(await rooms.answer(req.params.code, req.user!, questionIndex, optionIndex));
}));
