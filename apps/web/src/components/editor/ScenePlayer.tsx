import { useEffect, useRef, useState } from "react";
import type { Scene } from "@lvs/shared";
import { ListVideo, Pause, Play, Square } from "lucide-react";
import { useAssetUrl } from "../../api/context";
import { t } from "../../i18n";
import { formatDuration } from "../../lib/format";
import { setNarrationAudio } from "../../lib/narrationClock";
import { editorStore, useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";

export interface ScenePlayerProps {
  projectId: string;
  scene: Scene | undefined;
  hidden: boolean;
}

function isPlayable(scene: Scene | undefined, hidden: boolean): boolean {
  return !!scene && !hidden && !scene.muted && scene.audio.assetId !== undefined;
}

/** Per-scene narration player plus 「播放全部」, which walks through scenes in order. */
export function ScenePlayer({ projectId, scene, hidden }: ScenePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const playback = useEditor((s) => s.playback);
  const url = useAssetUrl(projectId, scene?.audio.assetId);
  const [time, setTime] = useState({ current: 0, duration: 0 });
  const playable = isPlayable(scene, hidden);

  // Drive the <audio> element from the store (keyboard and buttons both go through it).
  useEffect(() => {
    const el = audioRef.current;
    const store = editorStore.getState();
    if (!el) return;
    if (!playback.playing) {
      el.pause();
      return;
    }
    if (!playable) {
      if (playback.playAll) {
        if (!store.advanceToNextPlayable()) store.stopPlayback();
      } else {
        store.setPlaying(false);
      }
      return;
    }
    if (!url) return; // URL still resolving; the effect re-runs when it arrives.
    el.play().catch(() => editorStore.getState().setPlaying(false));
  }, [playback.playing, playback.playAll, playable, url]);

  useEffect(() => {
    setTime({ current: 0, duration: 0 });
    editorStore.getState().setCurrentTime(0);
  }, [url]);

  const onEnded = () => {
    const store = editorStore.getState();
    if (store.playback.playAll) {
      if (!store.advanceToNextPlayable()) store.stopPlayback();
    } else {
      store.setPlaying(false);
    }
  };

  // 「從這頁播到最後」: from the start of this page, not from wherever it was paused.
  const startAll = () => {
    const store = editorStore.getState();
    if (audioRef.current) audioRef.current.currentTime = 0;
    if (playable || store.advanceToNextPlayable()) store.startPlayAll();
  };

  const seek = (sec: number) => {
    const el = audioRef.current;
    if (!el || !Number.isFinite(sec)) return;
    const to = Math.max(0, Math.min(sec, el.duration || time.duration || 0));
    el.currentTime = to;
    setTime((t0) => ({ ...t0, current: to }));
    editorStore.getState().setCurrentTime(to);
  };

  // Old narration still plays after the script changed: say it is not what the script says now.
  const note = !scene
    ? null
    : scene.muted
      ? t.player.mutedScene
      : !scene.audio.assetId
        ? t.player.noAudio
        : scene.audio.status === "stale"
          ? t.player.staleAudio
          : null;
  const total = time.duration || scene?.durationSec || 0;

  return (
    // The note (舊語音…) gets its own line, so the seek bar never shrinks to nothing on narrow screens.
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
      <audio
        ref={(el) => {
          audioRef.current = el;
          setNarrationAudio(el);
        }}
        src={url}
        preload="auto"
        onEnded={onEnded}
        onTimeUpdate={(e) => {
          setTime({ current: e.currentTarget.currentTime, duration: e.currentTarget.duration || 0 });
          editorStore.getState().setCurrentTime(e.currentTarget.currentTime);
        }}
        onLoadedMetadata={(e) => setTime({ current: 0, duration: e.currentTarget.duration || 0 })}
      />
      <Button
        size="sm"
        variant="primary"
        icon={playback.playing ? Pause : Play}
        disabled={!playable}
        onClick={() => editorStore.getState().togglePlaying()}
        aria-label={playback.playing ? t.player.pause : t.player.play}
      >
        {playback.playing ? t.player.pause : t.player.play}
      </Button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="w-10 text-right font-mono text-xs text-neutral-400 tabular-nums">{formatDuration(time.current)}</span>
        {/* Seek bar: click or drag; ←／→ jump 5 seconds. */}
        <input
          type="range"
          className="h-1 min-w-0 flex-1 accent-[var(--color-accent-500)]"
          min={0}
          max={Math.max(total, 0.1)}
          step={0.1}
          value={Math.min(time.current, total)}
          disabled={!playable || !url}
          aria-label={t.player.seek}
          aria-valuetext={`${formatDuration(time.current)} / ${formatDuration(total)}`}
          onChange={(e) => seek(Number(e.target.value))}
          onKeyDown={(e) => {
            if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
            e.preventDefault();
            e.stopPropagation();
            seek(time.current + (e.key === "ArrowLeft" ? -5 : 5));
          }}
          data-testid="player-seek"
        />
        <span className="w-10 font-mono text-xs text-neutral-400 tabular-nums">
          {formatDuration(time.duration || scene?.durationSec || 0)}
        </span>
      </div>
      {note && <span className={`order-last basis-full text-xs ${scene?.audio.status === "stale" && !scene.muted ? "text-amber-300" : "text-neutral-400"}`}>{note}</span>}
      {playback.playAll ? (
        <Button size="sm" icon={Square} onClick={() => editorStore.getState().stopPlayback()}>
          {t.player.stopAll}
        </Button>
      ) : (
        <Button size="sm" icon={ListVideo} onClick={startAll}>
          {t.player.playAll}
        </Button>
      )}
    </div>
  );
}
