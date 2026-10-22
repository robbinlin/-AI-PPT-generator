import { useEffect, useRef, useState } from "react";
import { Loader2, Play, Square, Trash2, Upload } from "lucide-react";
import type {
  AspectRatio,
  Audience,
  AvatarAnchor,
  AvatarLayout,
  AvatarSettings,
  ContentBoundary,
  Language,
  ProviderInfo,
  ScriptMode,
  SubtitleSettings,
  SubtitleStyle,
  Transition,
  UpdateProjectRequest,
  VoiceSettings,
} from "@lvs/shared";
import { useApi } from "../../api/context";
import type { AvatarOption, VoiceOption } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { useEditor } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { errorMessage } from "../../api/types";
import { Button } from "../ui/Button";
import { Field, Select, Toggle, type Option } from "../ui/Field";
import {
  ColorInput,
  CommitNumber,
  CommitRange,
  CommitText,
  SettingsSection,
} from "./settingsFields";

type SettingsPatch = NonNullable<UpdateProjectRequest["settings"]>;

const AUDIENCES: Audience[] = [
  "undergraduate",
  "graduate",
  "general",
  "custom",
];
const MODES: ScriptMode[] = ["faithful", "extended", "summary"];
const LANGUAGES: Language[] = ["zh-TW", "en", "mixed"];
const BOUNDARIES: ContentBoundary[] = ["source_only", "allow_external"];
const ANCHORS: AvatarAnchor[] = [
  "bottom-right",
  "bottom-left",
  "top-right",
  "top-left",
  "right",
  "left",
];
const TRANSITIONS: Transition[] = ["none", "fade"];
const RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1"];

function opts<V extends string>(
  values: readonly V[],
  labels: Readonly<Record<V, string>>,
): Option<V>[] {
  return values.map((value) => ({ value, label: labels[value] }));
}

function providerOptions(
  providers: ProviderInfo[],
  kind: ProviderInfo["kind"],
  current: string | undefined,
): Option<string>[] {
  const list = providers
    .filter((p) => p.kind === kind)
    .map((p) => ({
      value: p.id,
      label: p.configured
        ? p.displayName
        : `${p.displayName} ${t.settings.notConfigured}`,
    }));
  if (current && !list.some((o) => o.value === current))
    list.unshift({ value: current, label: current });
  return list;
}

function withCurrent<T extends { id: string; name: string }>(
  items: T[],
  current: string | undefined,
): Option<string>[] {
  const list = items.map((i) => ({ value: i.id, label: i.name }));
  if (current && !list.some((o) => o.value === current))
    list.unshift({ value: current, label: current });
  return list;
}

export function SettingsPanel({
  actions,
}: {
  actions: Pick<EditorActions, "updateProject">;
}) {
  const api = useApi();
  const project = useEditor((s) => s.detail?.project);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [avatars, setAvatars] = useState<AvatarOption[]>([]);
  const voiceProvider = project?.settings.voice.providerId;
  const avatarProvider = project?.settings.avatar.providerId;

  useEffect(() => {
    api.listProviders().then(setProviders, () => setProviders([]));
  }, [api]);
  useEffect(() => {
    if (!voiceProvider) return;
    api.listVoices(voiceProvider).then(setVoices, (err: unknown) => {
      setVoices([]);
      toast(`${t.settings.voiceListFailed}：${errorMessage(err)}`, "error");
    });
  }, [api, voiceProvider]);
  // Provider ids may point at something no longer offered (e.g. the hidden mock provider) or be
  // unset: snap each kind to the first configured provider so generation never targets a ghost.
  useEffect(() => {
    if (!project || providers.length === 0) return;
    const pick = (kind: ProviderInfo["kind"], current: string | undefined) => {
      const list = providers.filter((p) => p.kind === kind);
      if (current && list.some((p) => p.id === current)) return undefined;
      return (list.find((p) => p.configured) ?? list[0])?.id;
    };
    const s0 = project.settings;
    const llm = pick("llm", s0.llmProviderId);
    const tts = pick("tts", s0.voice.providerId);
    const av = s0.avatar.enabled
      ? pick("avatar", s0.avatar.providerId)
      : undefined;
    if (!llm && !tts && !av) return;
    void actions.updateProject({
      settings: {
        ...(llm ? { llmProviderId: llm } : {}),
        ...(tts ? { voice: { ...s0.voice, providerId: tts } } : {}),
        ...(av ? { avatar: { ...s0.avatar, providerId: av } } : {}),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    providers,
    project?.settings.llmProviderId,
    project?.settings.voice.providerId,
    project?.settings.avatar.providerId,
    project?.settings.avatar.enabled,
  ]);
  // Same for avatar ids once the provider's list is known.
  const currentAvatarId = project?.settings.avatar.avatarId;
  useEffect(() => {
    if (
      !project ||
      avatars.length === 0 ||
      avatars.some((a) => a.id === currentAvatarId)
    )
      return;
    void actions.updateProject({
      settings: {
        avatar: { ...project.settings.avatar, avatarId: avatars[0]!.id },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatars, currentAvatarId]);
  // Voice ids are provider-specific: after switching providers, a leftover id (e.g. Gemini's
  // "Kore" sent to ElevenLabs) makes every synthesis fail, so snap to the first voice offered.
  const currentVoiceId = project?.settings.voice.voiceId;
  useEffect(() => {
    if (
      !project ||
      voices.length === 0 ||
      voices.some((v) => v.id === currentVoiceId)
    )
      return;
    void actions.updateProject({
      settings: {
        voice: { ...project.settings.voice, voiceId: voices[0]!.id },
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices, currentVoiceId]);
  useEffect(() => {
    if (!avatarProvider) return setAvatars([]);
    api.listAvatars(avatarProvider).then(setAvatars, (err: unknown) => {
      setAvatars([]);
      toast(`${t.settings.avatarListFailed}：${errorMessage(err)}`, "error");
    });
  }, [api, avatarProvider]);

  if (!project) return null;
  const s = project.settings;
  const patch = (settings: SettingsPatch) =>
    void actions.updateProject({ settings });
  const style = s.subtitles.style;
  const layout = s.avatar.layout;
  // Nested sections are sent whole: the shared schema's deepPartial() stops at defaulted
  // objects, so a partial nested object would be re-filled with defaults server-side.
  const setVoice = (p: Partial<VoiceSettings>) =>
    patch({ voice: { ...s.voice, ...p } });
  const setAvatar = (p: Partial<AvatarSettings>) =>
    patch({ avatar: { ...s.avatar, ...p } });
  const setLayout = (p: Partial<AvatarLayout>) =>
    setAvatar({ layout: { ...layout, ...p } });
  const setSubtitles = (p: Partial<SubtitleSettings>) =>
    patch({ subtitles: { ...s.subtitles, ...p } });
  const setStyle = (p: Partial<SubtitleStyle>) =>
    setSubtitles({ style: { ...style, ...p } });
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  return (
    <div className="pb-6">
      <p className="px-4 pt-3 text-[11px] text-neutral-500">
        {t.settings.savedHint}
      </p>

      <SettingsSection title={t.settings.sectionScript}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.audience}>
            <Select
              value={s.audience}
              options={opts(AUDIENCES, t.options.audience)}
              onChange={(audience) => patch({ audience })}
            />
          </Field>
          <Field label={t.settings.mode}>
            <Select
              value={s.mode}
              options={opts(MODES, t.options.mode)}
              onChange={(mode) => patch({ mode })}
            />
          </Field>
          <Field label={t.settings.language}>
            <Select
              value={s.language}
              options={opts(LANGUAGES, t.languages)}
              onChange={(language) => patch({ language })}
            />
          </Field>
          <Field label={t.settings.targetDuration}>
            <CommitNumber
              label={t.settings.targetDuration}
              value={s.targetDurationSec}
              min={10}
              max={36000}
              step={30}
              allowEmpty
              placeholder={t.settings.targetDurationAuto}
              onCommit={(targetDurationSec) => patch({ targetDurationSec })}
            />
          </Field>
        </div>
        {s.audience === "custom" && (
          <Field label={t.settings.audienceNote}>
            <CommitText
              label={t.settings.audienceNote}
              value={s.audienceNote ?? ""}
              maxLength={500}
              onCommit={(audienceNote) => patch({ audienceNote })}
            />
          </Field>
        )}
        <Field label={t.settings.contentBoundary}>
          <Select
            value={s.contentBoundary}
            options={opts(BOUNDARIES, t.options.contentBoundary)}
            onChange={(contentBoundary) => patch({ contentBoundary })}
          />
        </Field>
        <Field label={t.settings.styleNote}>
          <CommitText
            label={t.settings.styleNote}
            multiline
            maxLength={1000}
            value={s.styleNote ?? ""}
            placeholder={t.settings.styleNotePlaceholder}
            onCommit={(styleNote) => patch({ styleNote })}
          />
        </Field>
        <Field label={t.settings.llmProvider}>
          <Select
            value={s.llmProviderId}
            options={providerOptions(providers, "llm", s.llmProviderId)}
            onChange={(llmProviderId) => patch({ llmProviderId })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection title={t.settings.sectionVoice}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.voiceProvider}>
            <Select
              value={s.voice.providerId}
              options={providerOptions(providers, "tts", s.voice.providerId)}
              onChange={(providerId) => setVoice({ providerId })}
            />
          </Field>
          <Field label={t.settings.voiceId}>
            {voices.length > 0 ? (
              <Select
                value={s.voice.voiceId}
                options={withCurrent(voices, s.voice.voiceId)}
                onChange={(voiceId) => setVoice({ voiceId })}
              />
            ) : providers.find((p) => p.kind === "tts" && p.id === s.voice.providerId)?.customVoices ? (
              <p className="py-1.5 text-xs text-amber-300/90">{t.settings.noCustomVoices}</p>
            ) : (
              <CommitText
                label={t.settings.voiceId}
                value={s.voice.voiceId}
                onCommit={(voiceId) => voiceId && setVoice({ voiceId })}
              />
            )}
          </Field>
        </div>
        <VoicePreview
          providerId={s.voice.providerId}
          voiceId={s.voice.voiceId}
          language={s.language === "en" ? "en" : "zh-TW"}
        />
        {providers.find((p) => p.kind === "tts" && p.id === s.voice.providerId)
          ?.customVoices && (
          <VoiceUploader
            providerId={s.voice.providerId}
            voices={voices}
            selectedId={s.voice.voiceId}
            onChanged={(list, selectId) => {
              setVoices(list);
              if (selectId !== undefined) setVoice({ voiceId: selectId });
            }}
          />
        )}
        <Field label={t.settings.speed}>
          <CommitRange
            label={t.settings.speed}
            value={s.voice.speed}
            min={0.5}
            max={2}
            step={0.05}
            format={(v) => `${v.toFixed(2)}×`}
            onCommit={(speed) => setVoice({ speed })}
          />
        </Field>
        <Field label={t.settings.sentencePause}>
          <CommitRange
            label={t.settings.sentencePause}
            value={s.voice.sentencePauseSec}
            min={0}
            max={3}
            step={0.1}
            format={(v) => `${v.toFixed(1)}s`}
            onCommit={(sentencePauseSec) => setVoice({ sentencePauseSec })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection title={t.settings.sectionAvatar}>
        <Toggle
          label={t.settings.avatarEnabled}
          checked={s.avatar.enabled}
          onChange={(enabled) => setAvatar({ enabled })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.avatarProvider}>
            <Select
              value={s.avatar.providerId ?? ""}
              placeholder={t.settings.selectPlaceholder}
              options={providerOptions(
                providers,
                "avatar",
                s.avatar.providerId,
              )}
              onChange={(providerId) => setAvatar({ providerId })}
            />
          </Field>
          <Field label={t.settings.avatarId}>
            {avatars.length > 0 ? (
              <Select
                value={s.avatar.avatarId ?? ""}
                placeholder={t.settings.selectPlaceholder}
                options={withCurrent(avatars, s.avatar.avatarId)}
                onChange={(avatarId) => setAvatar({ avatarId })}
              />
            ) : (
              <CommitText
                label={t.settings.avatarId}
                value={s.avatar.avatarId ?? ""}
                onCommit={(avatarId) => setAvatar({ avatarId })}
              />
            )}
          </Field>
        </div>
        {providers.find(
          (p) => p.kind === "avatar" && p.id === s.avatar.providerId,
        )?.customCharacters && (
          <CharacterUploader
            providerId={s.avatar.providerId!}
            avatars={avatars}
            selectedId={s.avatar.avatarId}
            onChanged={(list, selectId) => {
              setAvatars(list);
              if (selectId !== undefined) setAvatar({ avatarId: selectId });
            }}
          />
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.shape}>
            <Select
              value={layout.shape}
              options={opts(["circle", "rect"] as const, t.options.shape)}
              onChange={(shape) => setLayout({ shape })}
            />
          </Field>
          <Field label={t.settings.anchor}>
            <Select
              value={layout.anchor}
              options={opts(ANCHORS, t.options.anchor)}
              onChange={(anchor) => setLayout({ anchor })}
            />
          </Field>
        </div>
        <Field label={t.settings.size}>
          <CommitRange
            label={t.settings.size}
            value={layout.size}
            min={0.1}
            max={0.6}
            step={0.01}
            format={pct}
            onCommit={(size) => setLayout({ size })}
          />
        </Field>
        <Field label={t.settings.margin}>
          <CommitRange
            label={t.settings.margin}
            value={layout.margin}
            min={0}
            max={0.2}
            step={0.005}
            format={pct}
            onCommit={(margin) => setLayout({ margin })}
          />
        </Field>
        <Toggle
          label={t.settings.visible}
          checked={layout.visible}
          onChange={(visible) => setLayout({ visible })}
        />
      </SettingsSection>

      <SettingsSection title={t.settings.sectionSubtitles}>
        <Toggle
          label={t.settings.subtitlesEnabled}
          checked={s.subtitles.enabled}
          onChange={(enabled) => setSubtitles({ enabled })}
        />
        <Toggle
          label={t.settings.burnIn}
          checked={s.subtitles.burnIn}
          disabled={!s.subtitles.enabled}
          onChange={(burnIn) => setSubtitles({ burnIn })}
        />
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.fontSize}>
            <CommitNumber
              label={t.settings.fontSize}
              value={style.fontSizePx}
              min={10}
              max={120}
              onCommit={(v) => v !== undefined && setStyle({ fontSizePx: v })}
            />
          </Field>
          <Field label={t.settings.maxChars}>
            <CommitNumber
              label={t.settings.maxChars}
              value={style.maxCharsPerLine}
              min={8}
              max={80}
              onCommit={(v) =>
                v !== undefined && setStyle({ maxCharsPerLine: v })
              }
            />
          </Field>
          <Field label={t.settings.color}>
            <ColorInput
              label={t.settings.color}
              value={style.color}
              onCommit={(color) => setStyle({ color })}
            />
          </Field>
          <Field label={t.settings.background}>
            <ColorInput
              label={t.settings.background}
              value={style.backgroundColor}
              onCommit={(backgroundColor) => setStyle({ backgroundColor })}
            />
          </Field>
          <Field label={t.settings.position}>
            <Select
              value={style.position}
              options={opts(["bottom", "top"] as const, t.options.position)}
              onChange={(position) => setStyle({ position })}
            />
          </Field>
        </div>
        <Field label={t.settings.bgOpacity}>
          <CommitRange
            label={t.settings.bgOpacity}
            value={style.backgroundOpacity}
            min={0}
            max={1}
            step={0.05}
            format={pct}
            onCommit={(backgroundOpacity) => setStyle({ backgroundOpacity })}
          />
        </Field>
      </SettingsSection>

      <SettingsSection title={t.settings.sectionVideo}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.transition}>
            <Select
              value={s.transition}
              options={opts(TRANSITIONS, t.options.transition)}
              onChange={(transition) => patch({ transition })}
            />
          </Field>
          <Field label={t.settings.aspectRatio}>
            <Select
              value={s.aspectRatio}
              options={opts(RATIOS, t.aspectRatios)}
              onChange={(aspectRatio) => patch({ aspectRatio })}
            />
          </Field>
        </div>
      </SettingsSection>
    </div>
  );
}

/** 試聽：synthesizes a short fixed sample with the selected voice and plays it in the browser. */
function VoicePreview({
  providerId,
  voiceId,
  language,
}: {
  providerId: string;
  voiceId: string;
  language: "zh-TW" | "en";
}) {
  const api = useApi();
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string | null>(null);

  const stop = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = null;
    setState("idle");
  };
  useEffect(() => stop, []);
  useEffect(() => {
    stop();
  }, [providerId, voiceId]);

  const play = async () => {
    if (state === "playing") return stop();
    setState("loading");
    try {
      const blob = await api.previewVoice(providerId, voiceId, language);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      urlRef.current = url;
      audio.onended = stop;
      audio.onerror = () => {
        toast(t.settings.previewFailed, "error");
        stop();
      };
      await audio.play();
      setState("playing");
    } catch (err) {
      toast(`${t.settings.previewFailed}：${errorMessage(err)}`, "error");
      stop();
    }
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        size="sm"
        icon={
          state === "loading" ? Loader2 : state === "playing" ? Square : Play
        }
        disabled={state === "loading"}
        onClick={() => void play()}
      >
        {state === "loading"
          ? t.settings.previewLoading
          : state === "playing"
            ? t.settings.previewStop
            : t.settings.previewVoice}
      </Button>
      <span className="text-[11px] text-neutral-500">
        {t.settings.previewHint}
      </span>
    </div>
  );
}

/** Upload / delete the user's own photo or clip for providers that accept custom characters (本機人像). */
function CharacterUploader({
  providerId,
  avatars,
  selectedId,
  onChanged,
}: {
  providerId: string;
  avatars: AvatarOption[];
  selectedId: string | undefined;
  onChanged: (list: AvatarOption[], selectId?: string) => void;
}) {
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const selected = avatars.find((a) => a.id === selectedId);

  const upload = async (file: File) => {
    setProgress(0);
    try {
      const created = await api.uploadAvatarCharacter(providerId, file, {
        onProgress: setProgress,
      });
      const list = await api.listAvatars(providerId);
      onChanged(list, created.id);
      toast(t.settings.characterUploaded);
    } catch (err) {
      toast(
        `${t.settings.characterUploadFailed}：${errorMessage(err)}`,
        "error",
      );
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    if (
      !selected ||
      !window.confirm(
        fmt(t.settings.deleteCharacterConfirm, { name: selected.name }),
      )
    )
      return;
    try {
      await api.deleteAvatarCharacter(providerId, selected.id);
      const list = await api.listAvatars(providerId);
      onChanged(list, list[0]?.id ?? "");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  return (
    <div className="flex items-start gap-3">
      {selected?.kind === "personal" && (
        <img
          src={api.avatarCharacterPreviewUrl(providerId, selected.id)}
          alt={selected.name}
          className="size-14 shrink-0 rounded-md object-cover ring-1 ring-neutral-700"
          onError={(e) => (e.currentTarget.style.visibility = "hidden")}
        />
      )}
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <input
            ref={fileInput}
            type="file"
            accept="image/jpeg,image/png,video/mp4,video/quicktime"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void upload(f);
            }}
          />
          <Button
            size="sm"
            icon={Upload}
            disabled={progress !== null}
            onClick={() => fileInput.current?.click()}
          >
            {progress === null
              ? t.settings.uploadCharacter
              : `${t.settings.uploadingCharacter} ${Math.round(progress * 100)}%`}
          </Button>
          {selected?.kind === "personal" && (
            <Button
              size="sm"
              variant="ghost"
              icon={Trash2}
              onClick={() => void remove()}
            >
              {t.settings.deleteCharacter}
            </Button>
          )}
        </div>
        <p className="text-[11px] text-neutral-500">
          {t.settings.uploadCharacterHint}
        </p>
      </div>
    </div>
  );
}

/** Upload / delete a reference clip of the user's own voice for providers that clone voices (本機語音). */
function VoiceUploader({
  providerId,
  voices,
  selectedId,
  onChanged,
}: {
  providerId: string;
  voices: VoiceOption[];
  selectedId: string;
  onChanged: (list: VoiceOption[], selectId?: string) => void;
}) {
  const api = useApi();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const selected = voices.find((v) => v.id === selectedId);
  const isCustom = !!selected && selected.name.startsWith("我的聲音");

  const upload = async (file: File) => {
    setProgress(0);
    try {
      const created = await api.uploadVoice(providerId, file, {
        onProgress: setProgress,
      });
      const list = await api.listVoices(providerId);
      onChanged(list, list.find((v) => v.id === created.id)?.id ?? created.id);
      toast(t.settings.voiceUploaded);
    } catch (err) {
      toast(`${t.settings.voiceUploadFailed}：${errorMessage(err)}`, "error");
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    if (
      !selected ||
      !window.confirm(
        fmt(t.settings.deleteVoiceConfirm, { name: selected.name }),
      )
    )
      return;
    try {
      await api.deleteVoice(providerId, selected.id);
      const list = await api.listVoices(providerId);
      onChanged(list, list[0]?.id ?? "");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex items-center gap-2">
        <input
          ref={fileInput}
          type="file"
          accept="audio/wav,audio/mpeg,audio/mp4,audio/x-m4a,audio/webm,.wav,.mp3,.m4a,.webm"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
        />
        <Button
          size="sm"
          icon={Upload}
          disabled={progress !== null}
          onClick={() => fileInput.current?.click()}
        >
          {progress === null
            ? t.settings.uploadVoice
            : `${t.settings.uploadingVoice} ${Math.round(progress * 100)}%`}
        </Button>
        {isCustom && (
          <Button
            size="sm"
            variant="ghost"
            icon={Trash2}
            onClick={() => void remove()}
          >
            {t.settings.deleteVoice}
          </Button>
        )}
      </div>
      <p className="text-[11px] text-neutral-500">
        {t.settings.uploadVoiceHint}
      </p>
    </div>
  );
}
