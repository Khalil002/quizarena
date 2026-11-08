import { describe, expect, it } from "vitest";
import { api, openSocket, registerUser, roomWithPlayers } from "./client.js";

describe("websocket", () => {
  it("sends a snapshot on connect and pushes every change", async () => {
    const { host, room } = await roomWithPlayers(0);
    const socket = openSocket(room.code, host.token);
    const first = await socket.waitFor((m) => m.type === "room.updated");
    expect(first.room).toMatchObject({ code: room.code, state: "lobby", players: [] });

    const player = await registerUser("live");
    await api("POST", `/rooms/${room.code}/join`, { token: player.token });
    const joined = await socket.waitFor((m) => m.room.players.length === 1);
    expect(joined.room.players[0]).toMatchObject({ userId: player.user.id, displayName: "live" });

    await api("POST", `/rooms/${room.code}/start`, { token: host.token });
    await socket.waitFor((m) => m.room.state === "question");
    await api("POST", `/rooms/${room.code}/answer`, { token: player.token, body: { questionIndex: 0, optionIndex: 1 } });
    const answered = await socket.waitFor((m) => m.room.answeredCount === 1);
    expect(answered.room.question.correctIndex).toBeNull(); // no spoilers before the reveal
    socket.ws.close();
  });

  it("refuses bad tokens and unknown rooms with close codes", async () => {
    const { host, room } = await roomWithPlayers(0);
    expect(await openSocket(room.code, "not-a-token").closed).toBe(4401);
    expect(await openSocket("ZZZZZZ", host.token).closed).toBe(4404);
  });
});
