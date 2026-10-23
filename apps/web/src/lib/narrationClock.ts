import { useEffect, type RefObject } from "react";

/**
 * The editor's narration <audio> element (ScenePlayer registers it). The avatar clip in the
 * preview follows its clock, so the lips move with the voice instead of looping on their own.
 */
let narration: HTMLAudioElement | null = null;

export function setNarrationAudio(el: HTMLAudioElement | null): void {
  narration = el;
}

export function getNarrationAudio(): HTMLAudioElement | null {
  return narration;
}

/** Above this the avatar is re-seeked while playing; below it the two clocks are left alone. */
export const MAX_DRIFT_SEC = 0.1;

/**
 * Where the avatar should be for a narration state: paused/stopped shows the matching frame,
 * playing runs alongside the audio, and past the clip's end it holds the last frame.
 */
export function avatarSyncAction(
  audio: { currentTime: number; paused: boolean; ended: boolean },
  video: { currentTime: number; paused: boolean; duration: number },
): { play: boolean; seekTo?: number } {
  const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration - 0.04 : Infinity;
  const target = Math.min(audio.currentTime, end);
  const playing = !audio.paused && !audio.ended && audio.currentTime < end;
  const drift = Math.abs(video.currentTime - target);
  const seekTo = drift > (playing ? MAX_DRIFT_SEC : 0.03) ? target : undefined;
  return seekTo === undefined ? { play: playing } : { play: playing, seekTo };
}

/** Keeps `videoRef` locked to the narration audio for as long as the component is mounted. */
export function useNarrationSync(videoRef: RefObject<HTMLVideoElement | null>, src: string | undefined): void {
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      const v = videoRef.current;
      if (!v || v.readyState < 1) return;
      const a = getNarrationAudio();
      const action = a ? avatarSyncAction(a, v) : { play: false, seekTo: v.currentTime > 0.03 ? 0 : undefined };
      if (action.seekTo !== undefined && !v.seeking) v.currentTime = action.seekTo;
      if (a && v.playbackRate !== a.playbackRate) v.playbackRate = a.playbackRate;
      if (action.play && v.paused) void v.play().catch(() => undefined);
      else if (!action.play && !v.paused) v.pause();
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [videoRef, src]);
}
