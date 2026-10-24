import { useEffect, useState } from "react";
import type { Project, ProviderInfo } from "@lvs/shared";
import { VoiceSettings } from "@lvs/shared";
import { useApi } from "../api/context";
import { errorMessage, type AvatarOption, type VoiceOption } from "../api/types";
import { fmt, t } from "../i18n";
import { useEditor } from "../store/editorStore";
import { toast } from "../store/toastStore";
import type { EditorActions } from "./useEditorActions";

/** Picked when the current voice is not offered by the chosen provider (matches the schema default). */
const DEFAULT_VOICE_ID = VoiceSettings.parse({}).voiceId;

/** Avatar lists are fetched by several components (panel, preview); share one request per provider. */
const avatarCache = new Map<string, Promise<AvatarOption[]>>();

export function invalidateAvatars(providerId: string): void {
  avatarCache.delete(providerId);
}

export function useAvatarList(providerId: string | undefined): [AvatarOption[], (list: AvatarOption[]) => void, boolean] {
  const api = useApi();
  const [avatars, setAvatars] = useState<AvatarOption[]>([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!providerId) {
      setAvatars([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    let p = avatarCache.get(providerId);
    if (!p) {
      p = api.listAvatars(providerId);
      avatarCache.set(providerId, p);
      p.catch(() => avatarCache.delete(providerId));
    }
    p.then(
      (list) => {
        if (!alive) return;
        setAvatars(list);
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setAvatars([]);
        setLoading(false);
        toast(`${t.settings.avatarListFailed}：${errorMessage(err)}`, "error");
      },
    );
    return () => {
      alive = false;
    };
  }, [api, providerId]);
  const set = (list: AvatarOption[]) => {
    if (providerId) avatarCache.set(providerId, Promise.resolve(list));
    setAvatars(list);
  };
  return [avatars, set, loading];
}

/**
 * Provider catalogue + the voice and avatar lists for the project's current providers, and the
 * self-healing that keeps settings pointing at something that exists (a hidden provider, a voice
 * id left over from another provider).
 */
export function useStudioLists(project: Project | undefined, actions: Pick<EditorActions, "updateProject">) {
  const api = useApi();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const voiceProvider = project?.settings.voice.providerId;
  const avatarProvider = project?.settings.avatar.providerId;
  const [avatars, setAvatars, avatarsLoading] = useAvatarList(avatarProvider);
  // Self-healing must never silently throw away finished work: once narration (or a paid
  // avatar) exists, a vanished voice/presenter is reported instead and the user picks a new one.
  const audioReady = useEditor((s) => !!s.detail?.scenes.some((sc) => sc.audio.status === "ready"));
  const avatarReady = useEditor((s) => !!s.detail?.scenes.some((sc) => sc.avatar.status === "ready"));

  useEffect(() => {
    api.listProviders().then(setProviders, () => setProviders([]));
  }, [api]);

  useEffect(() => {
    if (!voiceProvider) return;
    let alive = true;
    api.listVoices(voiceProvider).then(
      (list) => alive && setVoices(list),
      (err: unknown) => {
        if (!alive) return;
        setVoices([]);
        toast(`${t.settings.voiceListFailed}：${errorMessage(err)}`, "error");
      },
    );
    return () => {
      alive = false;
    };
  }, [api, voiceProvider]);

  // Snap each kind to the first configured provider when the stored one is not offered.
  useEffect(() => {
    if (!project || providers.length === 0) return;
    const pick = (kind: ProviderInfo["kind"], current: string | undefined) => {
      const list = providers.filter((p) => p.kind === kind);
      if (current && list.some((p) => p.id === current)) return undefined;
      return (list.find((p) => p.configured) ?? list[0])?.id;
    };
    const s0 = project.settings;
    const llm = pick("llm", s0.llmProviderId);
    const tts = audioReady ? undefined : pick("tts", s0.voice.providerId);
    const av = s0.avatar.enabled && !avatarReady ? pick("avatar", s0.avatar.providerId) : undefined;
    if (!llm && !tts && !av) return;
    void actions.updateProject({
      settings: {
        ...(llm ? { llmProviderId: llm } : {}),
        ...(tts ? { voice: { ...s0.voice, providerId: tts } } : {}),
        ...(av ? { avatar: { ...s0.avatar, providerId: av } } : {}),
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers, project?.settings.llmProviderId, project?.settings.voice.providerId, project?.settings.avatar.providerId, project?.settings.avatar.enabled]);

  const currentAvatarId = project?.settings.avatar.avatarId;
  useEffect(() => {
    if (!project || avatars.length === 0 || avatars.some((a) => a.id === currentAvatarId) || avatarReady) return;
    void actions.updateProject({ settings: { avatar: { ...project.settings.avatar, avatarId: avatars[0]!.id } } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatars, currentAvatarId]);

  const currentVoiceId = project?.settings.voice.voiceId;
  useEffect(() => {
    if (!project || voices.length === 0 || voices.some((v) => v.id === currentVoiceId) || audioReady) return;
    // A voice that speaks the project's language, preferring the default and stock voices over
    // someone's personal clone; and say which one was picked.
    const lang = project.settings.language === "en" ? "en" : "zh-TW";
    const speaks = (v: (typeof voices)[number]) => !v.languages?.length || v.languages.includes(lang);
    const fallback =
      voices.find((v) => v.id === DEFAULT_VOICE_ID && speaks(v)) ??
      voices.find((v) => speaks(v) && !v.name.startsWith("我的聲音")) ??
      voices.find(speaks) ??
      voices[0]!;
    void actions.updateProject({ settings: { voice: { ...project.settings.voice, voiceId: fallback.id } } }).then((ok) => {
      if (ok && currentVoiceId) toast(fmt(t.studio.voiceAutoPicked, { name: fallback.name }), "info");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voices, currentVoiceId]);

  // Shown in the panel when the stored choice is gone but finished work still depends on it.
  const missingVoice = voices.length > 0 && !!currentVoiceId && !voices.some((v) => v.id === currentVoiceId) ? currentVoiceId : undefined;
  const missingAvatar =
    !!project?.settings.avatar.enabled && avatars.length > 0 && !!currentAvatarId && !avatars.some((a) => a.id === currentAvatarId) ? currentAvatarId : undefined;
  return { providers, voices, setVoices, avatars, setAvatars, avatarsLoading, missingVoice, missingAvatar };
}

/** Image to show for an avatar character: local characters are proxied through the API. */
export function avatarImageUrl(
  api: { avatarCharacterPreviewUrl(providerId: string, id: string): string },
  providerId: string | undefined,
  a: AvatarOption | undefined,
): string | undefined {
  if (!a || !providerId) return undefined;
  if (providerId === "local") return api.avatarCharacterPreviewUrl(providerId, a.id);
  return a.previewImageUrl;
}
