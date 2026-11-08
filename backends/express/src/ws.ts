import type { Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { verifyToken } from "./auth.js";
import { keys, subscriber } from "./redis.js";
import * as rooms from "./rooms.js";

const PATH_RE = /^\/api\/rooms\/([A-Z2-9]{6})\/ws$/;

/**
 * WebSocket fan-out. Each instance pattern-subscribes to qa:events:* and forwards
 * every room update to the sockets it holds for that room, so players connected
 * to different instances all see the same game.
 */
export async function attachWebSockets(server: Server): Promise<void> {
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Map<string, Set<WebSocket>>();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    const match = PATH_RE.exec(url.pathname);
    if (!match) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => void onConnect(ws, match[1], url.searchParams.get("token") ?? undefined));
  });

  async function onConnect(ws: WebSocket, code: string, token: string | undefined) {
    // Browsers cannot read HTTP errors on an upgrade, so failures are close codes.
    if (!verifyToken(token)) return ws.close(4401, "unauthorized");
    let snapshot;
    try {
      snapshot = await rooms.view(code);
    } catch {
      return ws.close(4404, "room not found");
    }
    if (!sockets.has(code)) sockets.set(code, new Set());
    sockets.get(code)!.add(ws);
    ws.on("close", () => {
      sockets.get(code)?.delete(ws);
      if (sockets.get(code)?.size === 0) sockets.delete(code);
    });
    ws.send(JSON.stringify({ type: "room.updated", room: snapshot }));
  }

  await subscriber.psubscribe(keys.eventsPattern);
  subscriber.on("pmessage", (_pattern, channel, message) => {
    const code = channel.slice(channel.lastIndexOf(":") + 1);
    const frame = `{"type":"room.updated","room":${message}}`;
    for (const ws of sockets.get(code) ?? []) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  });

  // Keep idle connections alive through proxies.
  setInterval(() => wss.clients.forEach((ws) => ws.ping()), 25_000).unref();
}
