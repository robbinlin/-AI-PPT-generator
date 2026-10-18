import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { assets } from "../db/schema.js";
import { ApiHttpError, notFound } from "../errors.js";
import { requireProject } from "../services/projects.js";

export async function assetRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  /** Signed download; no auth beyond the signature so <img>/<video> tags can load it. */
  app.get<{ Params: { assetId: string }; Querystring: { sig?: string; exp?: string } }>("/assets/:assetId", async (req, reply) => {
    const { assetId } = req.params;
    if (!ctx.signer.verify(assetId, req.query.sig, req.query.exp)) {
      throw new ApiHttpError(403, "forbidden", "invalid or expired signature");
    }
    const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
    if (!asset) throw notFound("asset", assetId);

    let range: { start: number; end?: number } | undefined;
    const header = req.headers.range;
    if (header) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(header);
      if (!m) throw new ApiHttpError(416, "range_not_satisfiable", "bad Range header");
      if (m[1]) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
      else if (m[2]) range = { start: Math.max(0, asset.sizeBytes - Number(m[2])) };
    }
    let obj;
    try {
      obj = await ctx.storage.getStream(asset.storageKey, range);
    } catch (err) {
      if (err instanceof RangeError) throw new ApiHttpError(416, "range_not_satisfiable", err.message);
      throw err;
    }
    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", asset.mimeType);
    reply.header("Cache-Control", "private, max-age=3600");
    reply.header("Content-Disposition", `inline; filename="${asset.storageKey.split("/").pop()}"`);
    if (range) {
      reply.code(206);
      reply.header("Content-Range", `bytes ${obj.start}-${obj.end}/${obj.size}`);
      reply.header("Content-Length", obj.end - obj.start + 1);
    } else {
      reply.header("Content-Length", obj.size);
    }
    return reply.send(obj.stream);
  });

  app.get<{ Params: { id: string; assetId: string } }>("/projects/:id/assets/:assetId/url", async (req) => {
    const { ownerId } = ctx.auth.resolve(req);
    await requireProject(ctx.db, ownerId, req.params.id);
    const [asset] = await ctx.db.select().from(assets).where(eq(assets.id, req.params.assetId)).limit(1);
    if (!asset || asset.projectId !== req.params.id) throw notFound("asset", req.params.assetId);
    return ctx.storage.signUrl(asset.id, ctx.config.ASSET_URL_TTL_SEC);
  });
}
