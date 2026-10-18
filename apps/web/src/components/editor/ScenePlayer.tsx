import { useEffect, useRef, useState } from "react";
import type { Scene } from "@lvs/shared";
import { ListVideo, Pause, Play, Square } from "lucide-react";
import { useAssetUrl } from "../../api/context";
import { t } from "../../i18n";
import { formatDuration } from "../../lib/format";
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

  useEffect(() => setTime({ current: 0, duration: 0 }), [url]);

  const onEnded = () => {
    const store = editorStore.getState();
    if (store.playback.playAll) {
      if (!store.advanceToNextPlayable()) store.stopPlayback();
    } else {
      store.setPlaying(false);
    }
  };

  const startAll = () => {
    const store = editorStore.getState();
    if (playable || store.advanceToNextPlayable()) store.startPlayAll();
  };

  const note = !scene ? null : scene.muted ? t.player.mutedScene : !scene.audio.assetId ? t.player.noAudio : null;
  const progress = time.duration > 0 ? time.current / time.duration : 0;

  return (
    <div className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2">
      <audio
        ref={audioRef}
        src={url}
        preload="auto"
        onEnded={onEnded}
        onTimeUpdate={(e) => setTime({ current: e.currentTarget.currentTime, duration: e.currentTarget.duration || 0 })}
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
        <div className="h-1 flex-1 overflow-hidden rounded-full bg-neutral-800">
          <div className="h-full bg-accent-500" style={{ width: `${progress * 100}%` }} />
        </div>
        <span className="w-10 font-mono text-xs text-neutral-500 tabular-nums">
          {formatDuration(time.duration || scene?.durationSec || 0)}
        </span>
      </div>
      {note && <span className="text-xs text-neutral-500">{note}</span>}
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
