import { describe, expect, it } from "vitest";
import { api, expectProblem, registerUser, uniqueEmail } from "./client.js";

describe("health", () => {
  it("reports ok and names the backend", async () => {
    const res = await api("GET", "/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(["spring", "express", "dotnet"]).toContain(res.body.backend);
  });
});

describe("auth", () => {
  it("registers a player with a display name", async () => {
    const email = uniqueEmail("reg");
    const res = await api("POST", "/auth/register", { body: { email, password: "password123", displayName: "  Ada  " } });
    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({ email, displayName: "Ada", role: "player" });
    expect(res.body.token.split(".")).toHaveLength(3);
  });

  it("validates registration and rejects duplicate emails", async () => {
    const bad = await api("POST", "/auth/register", { body: { email: uniqueEmail(), password: "password123", displayName: "A" } });
    expectProblem(bad, 400, "VALIDATION_ERROR");
    const email = uniqueEmail("dup");
    await api("POST", "/auth/register", { body: { email, password: "password123", displayName: "Dup" } });
    const again = await api("POST", "/auth/register", { body: { email: email.toUpperCase(), password: "password123", displayName: "Dup" } });
    expectProblem(again, 409, "EMAIL_TAKEN");
  });

  it("logs in and returns the profile", async () => {
    const { user } = await registerUser("login");
    const ok = await api("POST", "/auth/login", { body: { email: user.email, password: "password123" } });
    expect(ok.status).toBe(200);
    const me = await api("GET", "/me", { token: ok.body.token });
    expect(me.body).toEqual(user);
    expectProblem(await api("POST", "/auth/login", { body: { email: user.email, password: "nope-nope" } }), 401, "INVALID_CREDENTIALS");
    expectProblem(await api("GET", "/me"), 401, "UNAUTHORIZED");
  });
});
