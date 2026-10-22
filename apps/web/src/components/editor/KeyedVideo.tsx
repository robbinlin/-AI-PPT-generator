import { useEffect, useRef, useState } from "react";

/** Providers whose clips come on chroma green (mirrors CHROMA_KEY_BY_PROVIDER in the API). */
export const CHROMA_PROVIDERS = new Set(["heygen", "local"]);

/** Makes strongly green RGBA pixels transparent and pulls green spill on the edges back to grey (in place). */
export function keyGreen(d: Uint8ClampedArray): void {
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!;
    const g = d[i + 1]!;
    const b = d[i + 2]!;
    const excess = g - Math.max(r, b);
    if (excess > 70) d[i + 3] = 0;
    else if (excess > 25) {
      d[i + 3] = Math.round(255 * (1 - (excess - 25) / 45));
      d[i + 1] = Math.max(r, b);
    }
  }
}

/**
 * Plays a green-screen clip with the green removed, so the editor preview matches the render.
 * The video is drawn to a small canvas each frame; strongly green pixels become transparent and
 * green spill on the edges is pulled back to grey.
 */
export function KeyedVideo({ src, poster, className }: { src: string; poster?: string; className?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [drawn, setDrawn] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const v = video.current;
    const c = canvas.current;
    if (!v || !c) return;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      if (v.readyState >= 2 && v.videoWidth) {
        const h = Math.min(360, v.videoHeight);
        const w = Math.round((v.videoWidth / v.videoHeight) * h);
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        ctx.drawImage(v, 0, 0, w, h);
        const img = ctx.getImageData(0, 0, w, h);
        keyGreen(img.data);
        ctx.putImageData(img, 0, 0);
        setDrawn(true);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [src]);

  return (
    <>
      <video ref={video} src={src} className="hidden" muted loop autoPlay playsInline crossOrigin="anonymous" />
      {!drawn && poster && <img src={poster} alt="" className={className} draggable={false} />}
      <canvas ref={canvas} className={`${className ?? ""} ${drawn ? "" : "hidden"}`} data-testid="keyed-video" />
    </>
  );
}
