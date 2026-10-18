import type { FastifyInstance } from "fastify";
import { SetProviderKeyRequest } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { parse } from "../util/validate.js";

export async function providerRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get("/providers", async (req) => ctx.providers.list(ctx.auth.resolve(req).ownerId));

  app.put<{ Params: { providerId: string } }>("/providers/:providerId/key", async (req) => {
    const body = parse(SetProviderKeyRequest, req.body);
    return ctx.providers.setKey(ctx.auth.resolve(req).ownerId, req.params.providerId, body.apiKey);
  });

  app.delete<{ Params: { providerId: string } }>("/providers/:providerId/key", async (req) =>
    ctx.providers.deleteKey(ctx.auth.resolve(req).ownerId, req.params.providerId),
  );

  app.get<{ Params: { providerId: string } }>("/providers/:providerId/voices", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const tts = await ctx.providers.requireTts(ownerId, req.params.providerId);
    return tts.listVoices();
  });

  app.get<{ Params: { providerId: string } }>("/providers/:providerId/avatars", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const avatar = await ctx.providers.requireAvatar(ownerId, req.params.providerId);
    return avatar.listAvatars();
  });
}
