import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { config } from "./config.js";
import { ApiError } from "./errors.js";

export type Role = "player" | "admin";
export interface AuthUser { id: string; email: string; displayName: string; role: Role }

declare module "express-serve-static-core" {
  interface Request { user?: AuthUser }
}

const ISSUER = "quizarena";

/** HS256 token with the claims every backend reads: sub, email, name, role. */
export function issueToken(user: AuthUser): string {
  return jwt.sign({ email: user.email, name: user.displayName, role: user.role }, config.jwtSecret, {
    algorithm: "HS256", subject: user.id, issuer: ISSUER, expiresIn: config.jwtTtlSec,
  });
}

/** Returns the user for a raw token, or undefined if it is missing or invalid. */
export function verifyToken(token: string | undefined): AuthUser | undefined {
  if (!token) return undefined;
  try {
    const c = jwt.verify(token, config.jwtSecret, { algorithms: ["HS256"], issuer: ISSUER }) as jwt.JwtPayload;
    return { id: String(c.sub), email: String(c.email), displayName: String(c.name), role: c.role as Role };
  } catch {
    return undefined;
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const [scheme, token] = (req.header("authorization") ?? "").split(" ");
  const user = scheme?.toLowerCase() === "bearer" ? verifyToken(token) : undefined;
  if (!user) return next(new ApiError(401, "UNAUTHORIZED", "Missing, invalid or expired token"));
  req.user = user;
  next();
}
