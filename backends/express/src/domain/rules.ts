import { randomInt } from "node:crypto";

/** Room codes avoid look-alike characters (no I, O, 0, 1). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_RE = /^[A-Z2-9]{6}$/;

export function roomCode(pick: (max: number) => number = randomInt): string {
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return code;
}

/**
 * Server-side scoring: 500 for a correct answer plus up to 500 more for speed,
 * measured from when the question opened on the server. Wrong answers score 0.
 */
export function points(correct: boolean, elapsedMs: number, timeLimitSec: number): number {
  if (!correct) return 0;
  const limitMs = timeLimitSec * 1000;
  const left = Math.min(limitMs, Math.max(0, limitMs - elapsedMs));
  return 500 + Math.floor((500 * left) / limitMs);
}

export interface RankedPlayer { userId: string; displayName: string; score: number }

/** Score descending, then display name, then id: the same order in every backend. */
export function sortPlayers<T extends RankedPlayer>(players: T[]): T[] {
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...players].sort((a, b) => b.score - a.score || cmp(a.displayName, b.displayName) || cmp(a.userId, b.userId));
}

/** Competition ranking: 1 + the number of players with a strictly higher score. */
export const rankOf = (score: number, all: number[]): number => 1 + all.filter((s) => s > score).length;

export function rateWindow(nowMs: number, windowSec: number): { window: number; retryAfterSec: number } {
  const nowSec = Math.floor(nowMs / 1000);
  const window = Math.floor(nowSec / windowSec);
  return { window, retryAfterSec: Math.max(1, (window + 1) * windowSec - nowSec) };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string): boolean => UUID_RE.test(value);
