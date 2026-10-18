import { loadConfig } from "./config.js";
import { buildServer } from "./server.js";

const config = loadConfig();
const server = await buildServer({ config });

const shutdown = async (signal: string) => {
  server.app.log.info({ signal }, "shutting down");
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await server.app.listen({ port: config.PORT, host: config.HOST });
server.app.log.info({ driver: server.dbHandle.driver, storage: config.STORAGE_ROOT }, "api ready");
