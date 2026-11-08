import { randomUUID } from "node:crypto";

export const API_URL = (process.env.API_URL ?? "http://localhost:8000/api").replace(/\/$/, "");
export const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX ?? 10);
const ADMIN = {
  email: process.env.ADMIN_EMAIL ?? "admin@quizarena.local",
  password: process.env.ADMIN_PASSWORD ?? "admin1234",
};

export async function api(method, path, { token, body, headers = {} } = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  return { status: res.status, headers: res.headers, body: json };
}

export const uniqueEmail = (tag = "user") => `${tag}-${randomUUID().slice(0, 12)}@test.local`;

export async function registerUser(tag = "player") {
  const res = await api("POST", "/auth/register", {
    body: { email: uniqueEmail(tag), password: "password123", displayName: tag.slice(0, 20) },
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

let adminToken;
export async function admin() {
  if (!adminToken) {
    const res = await api("POST", "/auth/login", { body: ADMIN });
    if (res.status !== 200) throw new Error(`admin login failed: ${res.status}`);
    adminToken = res.body.token;
  }
  return adminToken;
}

export const sampleQuiz = (overrides = {}) => ({
  title: `Quiz ${randomUUID().slice(0, 6)}`,
  questions: [
    { prompt: "2 + 2?", options: ["3", "4", "5"], correctIndex: 1, timeLimitSec: 30 },
    { prompt: "Capital of France?", options: ["Paris", "Rome"], correctIndex: 0, timeLimitSec: 30 },
  ],
  ...overrides,
});

export async function createQuiz(token, overrides) {
  const res = await api("POST", "/quizzes", { token, body: sampleQuiz(overrides) });
  if (res.status !== 201) throw new Error(`create quiz failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** A host with a quiz and an open room, plus `n` joined players. */
export async function roomWithPlayers(n = 2, quizOverrides) {
  const host = await registerUser("host");
  const quiz = await createQuiz(host.token, quizOverrides);
  const room = (await api("POST", "/rooms", { token: host.token, body: { quizId: quiz.id } })).body;
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = await registerUser(`p${i}`);
    const joined = await api("POST", `/rooms/${room.code}/join`, { token: p.token });
    if (joined.status !== 200) throw new Error(`join failed: ${joined.status}`);
    players.push(p);
  }
  return { host, quiz, room, players };
}

export async function eventually(fn, { timeoutMs = 15_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export const expectProblem = (res, status, code) => {
  if (res.status !== status || res.body?.code !== code) {
    throw new Error(`expected ${status} ${code}, got ${res.status} ${JSON.stringify(res.body)}`);
  }
  if (!String(res.headers.get("content-type")).includes("application/problem+json")) {
    throw new Error(`expected problem+json, got ${res.headers.get("content-type")}`);
  }
};

/** Opens the room socket and collects every message it receives. */
export function openSocket(code, token) {
  const url = `${API_URL.replace(/^http/, "ws")}/rooms/${code}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(url);
  const messages = [];
  const closed = new Promise((resolve) => ws.addEventListener("close", (e) => resolve(e.code)));
  ws.addEventListener("message", (e) => messages.push(JSON.parse(e.data)));
  const waitFor = (predicate, timeoutMs = 10_000) =>
    eventually(() => messages.find(predicate), { timeoutMs, intervalMs: 50 });
  return { ws, messages, closed, waitFor };
}
