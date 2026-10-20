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

  /** Short sample so the user can hear a voice before committing to it. */
  app.post<{ Params: { providerId: string; voiceId: string }; Querystring: { language?: string } }>(
    "/providers/:providerId/voices/:voiceId/preview",
    async (req, reply) => {
      const { ownerId } = ctx.auth.resolve(req);
      const tts = await ctx.providers.requireTts(ownerId, req.params.providerId);
      const language = req.query.language === "en" ? "en" : "zh-TW";
      const text =
        language === "en"
          ? "Hello, this is a sample of my voice. Today we will look at how high intensity interval training changes VO two max."
          : "各位同學好，這是我的聲音示範。今天我們要看高強度間歇訓練對最大攝氧量的影響。";
      const res = await tts.synthesize({ text, voiceId: req.params.voiceId, language });
      reply.header("Cache-Control", "no-store");
      return reply.type(res.data.mimeType).send(Buffer.from(res.data.audio));
    },
  );

  app.get<{ Params: { providerId: string } }>("/providers/:providerId/avatars", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    const avatar = await ctx.providers.requireAvatar(ownerId, req.params.providerId);
    return avatar.listAvatars();
  });
}
