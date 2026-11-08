import { z } from "zod";

export const registrationSchema = z.object({
  email: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "must be an email address").max(254),
  password: z.string().min(8).max(72),
  displayName: z.string().trim().min(2).max(24),
});

const questionSchema = z.object({
  prompt: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(100)).min(2).max(4),
  correctIndex: z.number().int().min(0),
  timeLimitSec: z.number().int().min(5).max(120),
}).refine((q) => q.correctIndex < q.options.length, { message: "correctIndex must point at an option", path: ["correctIndex"] });

export const newQuizSchema = z.object({
  title: z.string().trim().min(1).max(120),
  questions: z.array(questionSchema).min(1).max(50),
});

export type QuestionInput = z.infer<typeof questionSchema>;

export const newRoomSchema = z.object({ quizId: z.string().uuid() });

export const answerSchema = z.object({
  questionIndex: z.number().int().min(0),
  optionIndex: z.number().int().min(0),
});
