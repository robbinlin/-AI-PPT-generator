import type { FastifyInstance } from "fastify";
import { SetProviderKeyRequest } from "@lvs/shared";
import type { AppContext } from "../context.js";
import { parse } from "../util/validate.js";
import { badRequest, notFound, upstream } from "../errors.js";

export async function providerRoutes(
  app: FastifyInstance,
  ctx: AppContext,
): Promise<void> {
  app.get("/providers", async (req) =>
    ctx.providers.list(ctx.auth.resolve(req).ownerId),
  );

  app.put<{ Params: { providerId: string } }>(
    "/providers/:providerId/key",
    async (req) => {
      const body = parse(SetProviderKeyRequest, req.body);
      return ctx.providers.setKey(
        ctx.auth.resolve(req).ownerId,
        req.params.providerId,
        body.apiKey,
      );
    },
  );

  app.delete<{ Params: { providerId: string } }>(
    "/providers/:providerId/key",
    async (req) =>
      ctx.providers.deleteKey(
        ctx.auth.resolve(req).ownerId,
        req.params.providerId,
      ),
  );

  app.get<{ Params: { providerId: string } }>(
    "/providers/:providerId/voices",
    async (req) => {
      const { ownerId } = ctx.auth.resolve(req);
      const tts = await ctx.providers.requireTts(
        ownerId,
        req.params.providerId,
      );
      try {
        return await tts.listVoices();
      } catch (err) {
        req.log.warn(
          { err, providerId: req.params.providerId },
          "listing voices failed",
        );
        throw upstream(req.params.providerId, err);
      }
    },
  );

  /** Short sample so the user can hear a voice before committing to it. */
  app.post<{
    Params: { providerId: string; voiceId: string };
    Querystring: { language?: string };
  }>("/providers/:providerId/voices/:voiceId/preview", async (req, reply) => {
    const { ownerId } = ctx.auth.resolve(req);
    const tts = await ctx.providers.requireTts(ownerId, req.params.providerId);
    const language = req.query.language === "en" ? "en" : "zh-TW";
    const text =
      language === "en"
        ? "Hello, this is a sample of my voice. Today we will look at how high intensity interval training changes VO two max."
        : "各位同學好，這是我的聲音示範。今天我們要看高強度間歇訓練對最大攝氧量的影響。";
    let res;
    try {
      res = await tts.synthesize({
        text,
        voiceId: req.params.voiceId,
        language,
      });
    } catch (err) {
      req.log.warn(
        { err, providerId: req.params.providerId, voiceId: req.params.voiceId },
        "voice preview failed",
      );
      throw upstream(req.params.providerId, err);
    }
    reply.header("Cache-Control", "no-store");
    return reply.type(res.data.mimeType).send(Buffer.from(res.data.audio));
  });

  /** Upload the user's own photo/video as a character (providers with customCharacters). */
  app.post<{ Params: { providerId: string } }>(
    "/providers/:providerId/characters",
    async (req, reply) => {
      const { ownerId } = ctx.auth.resolve(req);
      const avatar = await ctx.providers.requireAvatar(
        ownerId,
        req.params.providerId,
      );
      if (!avatar.createCharacter)
        throw badRequest(
          `provider ${req.params.providerId} does not accept custom characters`,
        );
      const part = await req.file();
      if (!part) throw badRequest("multipart field `file` is required");
      const data = await part.toBuffer();
      if (part.file.truncated)
        throw badRequest(`file exceeds ${ctx.config.MAX_UPLOAD_BYTES} bytes`);
      const nameField = (
        part.fields as Record<string, { value?: unknown } | undefined>
      ).name?.value;
      const name =
        typeof nameField === "string" && nameField.trim()
          ? nameField.trim()
          : part.filename.replace(/\.[^.]+$/, "");
      try {
        reply.code(201);
        return await avatar.createCharacter({
          data,
          mimeType: part.mimetype,
          fileName: part.filename,
          name,
        });
      } catch (err) {
        req.log.warn(
          { err, providerId: req.params.providerId },
          "character upload failed",
        );
        throw upstream(req.params.providerId, err);
      }
    },
  );

  app.delete<{ Params: { providerId: string; characterId: string } }>(
    "/providers/:providerId/characters/:characterId",
    async (req, reply) => {
      const { ownerId } = ctx.auth.resolve(req);
      const avatar = await ctx.providers.requireAvatar(
        ownerId,
        req.params.providerId,
      );
      if (!avatar.deleteCharacter)
        throw badRequest(
          `provider ${req.params.providerId} does not accept custom characters`,
        );
      try {
        await avatar.deleteCharacter(req.params.characterId);
      } catch (err) {
        throw upstream(req.params.providerId, err);
      }
      return reply.code(204).send();
    },
  );

  /** Preview image proxied through the API so the browser never needs the worker's address. */
  app.get<{ Params: { providerId: string; characterId: string } }>(
    "/providers/:providerId/characters/:characterId/preview",
    async (req, reply) => {
      const { ownerId } = ctx.auth.resolve(req);
      const avatar = await ctx.providers.requireAvatar(
        ownerId,
        req.params.providerId,
      );
      if (!avatar.characterPreview) throw notFound("preview");
      try {
        const img = await avatar.characterPreview(req.params.characterId);
        reply.header("Cache-Control", "private, max-age=300");
        return reply.type(img.mimeType).send(Buffer.from(img.data));
      } catch (err) {
        throw upstream(req.params.providerId, err);
      }
    },
  );

  app.get<{ Params: { providerId: string } }>(
    "/providers/:providerId/avatars",
    async (req) => {
      const { ownerId } = ctx.auth.resolve(req);
      const avatar = await ctx.providers.requireAvatar(
        ownerId,
        req.params.providerId,
      );
      try {
        return await avatar.listAvatars();
      } catch (err) {
        req.log.warn(
          { err, providerId: req.params.providerId },
          "listing avatars failed",
        );
        throw upstream(req.params.providerId, err);
      }
    },
  );
}
