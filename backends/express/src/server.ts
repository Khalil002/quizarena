import { createServer } from "node:http";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { pool } from "./db.js";
import { redis, subscriber } from "./redis.js";
import { attachWebSockets } from "./ws.js";
import { archiveTick, ensureGroup } from "./archive.js";

const server = createServer(createApp());
await attachWebSockets(server);
server.listen(config.port, () => console.log(`quizarena express backend listening on :${config.port}`));

let stopped = false;
async function archiveLoop() {
  while (!stopped) {
    try {
      await ensureGroup();
      await archiveTick();
    } catch (err) {
      console.error("[archive]", (err as Error).message);
    }
    await new Promise((r) => setTimeout(r, config.archiveIntervalMs));
  }
}
void archiveLoop();

const shutdown = () => {
  stopped = true;
  server.close(() => {
    void Promise.allSettled([pool.end(), redis.quit(), subscriber.quit()]).then(() => process.exit(0));
  });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
