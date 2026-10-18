import type { FastifyInstance } from "fastify";

export const API_VERSION = "0.1.0";

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true, version: API_VERSION }));
}
