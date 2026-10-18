import type { FastifyInstance } from "fastify";
import { SetProviderKeyRequest } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { notImplemented } from "../errors.js";
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

  // TODO(providers): resolve the TtsProvider / AvatarProvider from @lvs/providers with
  // ctx.providers.credentials(...) and return listVoices() / listAvatars().
  app.get<{ Params: { providerId: string } }>("/providers/:providerId/voices", async (req) => {
    const d = ctx.providers.descriptor(req.params.providerId);
    if (d.kind !== "tts") throw notImplemented(`${d.id} is not a TTS provider`);
    throw notImplemented("voice listing is not wired yet");
  });
  app.get<{ Params: { providerId: string } }>("/providers/:providerId/avatars", async (req) => {
    const d = ctx.providers.descriptor(req.params.providerId);
    if (d.kind !== "avatar") throw notImplemented(`${d.id} is not an avatar provider`);
    throw notImplemented("avatar listing is not wired yet");
  });
}
