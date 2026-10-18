import { createHmac, timingSafeEqual } from "node:crypto";

/** HMAC-SHA256 over `${assetId}:${exp}`; `exp` is unix seconds. */
export class AssetUrlSigner {
  constructor(
    private readonly secret: string,
    private readonly publicBaseUrl: string,
  ) {}

  private mac(assetId: string, exp: number): string {
    return createHmac("sha256", this.secret).update(`${assetId}:${exp}`).digest("base64url");
  }

  sign(assetId: string, ttlSec: number, now = Date.now()): { url: string; expiresAt: string; sig: string; exp: number } {
    const exp = Math.floor(now / 1000) + ttlSec;
    const sig = this.mac(assetId, exp);
    const base = this.publicBaseUrl.replace(/\/$/, "");
    return {
      url: `${base}/assets/${assetId}?sig=${sig}&exp=${exp}`,
      expiresAt: new Date(exp * 1000).toISOString(),
      sig,
      exp,
    };
  }

  verify(assetId: string, sig: string | undefined, exp: string | number | undefined, now = Date.now()): boolean {
    if (!sig || exp === undefined) return false;
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum * 1000 < now) return false;
    const expected = Buffer.from(this.mac(assetId, expNum));
    const given = Buffer.from(String(sig));
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
