import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Ban, Check, ChevronDown, Loader2, Pencil, Play, Plus, RotateCcw, Search, Square, Trash2, UserRound } from "lucide-react";
import type { AvatarLayout, AvatarSettings, Project, ProviderInfo, SubtitleSettings, SubtitleStyle, UpdateProjectRequest, VoiceSettings } from "@lvs/shared";
import { useApi } from "../../api/context";
import { errorMessage, type AvatarOption, type VoiceOption } from "../../api/types";
import type { EditorActions } from "../../hooks/useEditorActions";
import { avatarImageUrl, invalidateAvatars, useStudioLists } from "../../hooks/useStudioLists";
import { fmt, t } from "../../i18n";
import { LAYOUT_PRESETS, matchLayoutPreset, matchSubtitlePreset, SUBTITLE_PRESETS, subtitleCss } from "../../lib/studioPresets";
import { useEditor } from "../../store/editorStore";
import { confirmAction } from "../../store/confirmStore";
import { toast } from "../../store/toastStore";
import { Button } from "../ui/Button";
import { Field, Select, Toggle } from "../ui/Field";
import { Modal } from "../ui/Modal";
import { ColorInput, CommitNumber, CommitRange } from "./settingsFields";

type SettingsPatch = NonNullable<UpdateProjectRequest["settings"]>;
const GALLERY_COUNT = 10;

/** Step 3 of the VoAI-style flow: who presents (avatar + layout), with which voice, and how captions look. */
/** Voice fields that change the audio (and with it every avatar clip lip-synced to it). */
const VOICE_AUDIO_KEYS: (keyof VoiceSettings)[] = ["providerId", "voiceId", "speed", "sentencePauseSec", "pronunciationDictionaryId"];

export function StudioPanel({ actions }: { actions: Pick<EditorActions, "updateProject" | "changeSettings"> }) {
  const project = useEditor((s) => s.detail?.project);
  const { providers, voices, setVoices, avatars, setAvatars, avatarsLoading, missingVoice, missingAvatar } = useStudioLists(project, actions);
  if (!project) return null;
  const s = project.settings;
  const patch = (settings: SettingsPatch) => void actions.updateProject({ settings });
  // Changes that would throw away finished audio/avatars go through changeSettings: it warns
  // before paid avatars become 需更新 and offers 復原 afterwards.
  const setVoice = (p: Partial<VoiceSettings>) => {
    const audio = VOICE_AUDIO_KEYS.some((k) => k in p && p[k] !== s.voice[k]);
    void actions.changeSettings({ voice: { ...s.voice, ...p } }, audio ? "audio" : "none");
  };
  const setAvatar = (p: Partial<AvatarSettings>) => {
    const changesClip = ("avatarId" in p && p.avatarId !== s.avatar.avatarId) || ("providerId" in p && p.providerId !== s.avatar.providerId);
    void actions.changeSettings({ avatar: { ...s.avatar, ...p } }, changesClip ? "avatar" : "none");
  };
  const setLayout = (p: Partial<AvatarLayout>) => setAvatar({ layout: { ...s.avatar.layout, ...p } });
  const setSubtitles = (p: Partial<SubtitleSettings>) => patch({ subtitles: { ...s.subtitles, ...p } });
  const setStyle = (p: Partial<SubtitleStyle>) => setSubtitles({ style: { ...s.subtitles.style, ...p } });

  return (
    <div className="pb-8">
      {/* The stored voice/presenter is no longer offered; finished work still uses it, so the user chooses. */}
      {(missingVoice || missingAvatar) && (
        <div className="mx-4 mt-4 flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100" role="alert" data-testid="missing-choice">
          {missingAvatar && <span>{t.studio.missingAvatar}</span>}
          {missingVoice && <span>{fmt(t.studio.missingVoice, { id: missingVoice })}</span>}
        </div>
      )}
      <AvatarSection project={project} providers={providers} avatars={avatars} loading={avatarsLoading} setAvatars={setAvatars} setAvatar={setAvatar} />
      <LayoutSection project={project} setLayout={setLayout} setAvatar={setAvatar} patch={patch} />
      <VoiceSection project={project} providers={providers} voices={voices} setVoices={setVoices} setVoice={setVoice} />
      <SubtitleSection project={project} setSubtitles={setSubtitles} setStyle={setStyle} />
    </div>
  );
}

// ---------------------------------------------------------------- shared bits --

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="border-b border-neutral-800 px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold tracking-wide text-neutral-200">{title}</h3>
        {aside}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </section>
  );
}

function ProviderPills({
  providers,
  kind,
  value,
  onChange,
}: {
  providers: ProviderInfo[];
  kind: ProviderInfo["kind"];
  value: string | undefined;
  onChange: (id: string) => void;
}) {
  const list = providers.filter((p) => p.kind === kind);
  if (list.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t.studio.provider}>
      {list.map((p) => (
        <button
          key={p.id}
          type="button"
          role="radio"
          aria-checked={p.id === value}
          title={p.hint ?? (p.configured ? undefined : t.settings.notConfigured)}
          onClick={() => onChange(p.id)}
          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
            p.id === value
              ? "border-accent-400 bg-accent-500/20 text-accent-100"
              : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
          } ${p.configured ? "" : "opacity-60"}`}
        >
          {p.displayName}
          {priceHint(p.id) && <span className="text-xs text-neutral-400">・{priceHint(p.id)}</span>}
          {!p.configured && " ⚠"}
        </button>
      ))}
    </div>
  );
}

function priceHint(providerId: string): string | undefined {
  // Local providers already say 免費 in their display name.
  if (providerId === "local" || providerId === "cosyvoice" || providerId === "gpt-sovits" || providerId === "fish-speech") return undefined;
  return (t.studio.price as Record<string, string>)[providerId];
}

const SCENE_WORDS: Array<[RegExp, string]> = [
  [/\bliving room\b/i, "客廳"],
  [/\boffice\b/i, "辦公室"],
  [/\bkitchen\b/i, "廚房"],
  [/\bstudio\b/i, "攝影棚"],
  [/\blobby\b/i, "大廳"],
  [/\blibrary\b/i, "圖書館"],
  [/\bclassroom\b/i, "教室"],
  [/\boutdoors?\b/i, "戶外"],
  [/\bsofa\b|\bcouch\b/i, "沙發"],
  [/\bcasual\b/i, "休閒"],
  [/\bbusiness\b/i, "商務"],
];

/** 「Dante Living Room 3」 → 「Dante・客廳 3」: the person's name stays, the scene is in Chinese. */
export function localizeStockName(name: string): string {
  const m = /^([A-Z][\w'-]*)\s+(.+)$/.exec(name.trim());
  if (!m) return name;
  let rest = m[2]!;
  let hit = false;
  for (const [re, zh] of SCENE_WORDS) {
    if (re.test(rest)) {
      rest = rest.replace(re, zh);
      hit = true;
    }
  }
  return hit ? `${m[1]}・${rest.replace(/\s{2,}/g, " ")}` : name;
}

/**
 * Display names: the user's own presenters get Chinese names by type (「我的照片型人像 1」; HeyGen
 * names them in English, e.g. "Man in black ribbed sweater"); stock ones keep their name, with a
 * running number when several share it.
 */
function distinctNames(avatars: AvatarOption[]): Map<string, string> {
  const total = new Map<string, number>();
  for (const a of avatars) total.set(a.name, (total.get(a.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const out = new Map<string, string>();
  const mine = new Map<string, number>();
  for (const a of avatars) {
    if (a.kind === "personal") {
      const type = a.source ? t.studio.source[a.source] : t.studio.personalGeneric;
      const n = (mine.get(type) ?? 0) + 1;
      mine.set(type, n);
      out.set(a.id, fmt(t.studio.personalName, { type, n }));
      continue;
    }
    if ((total.get(a.name) ?? 0) < 2) {
      out.set(a.id, localizeStockName(a.name));
      continue;
    }
    const n = (seen.get(a.name) ?? 0) + 1;
    seen.set(a.name, n);
    out.set(a.id, `${localizeStockName(a.name)} #${n}`);
  }
  return out;
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-xs text-neutral-300 hover:text-neutral-100"
      >
        {label}
        <ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} aria-hidden />
      </button>
      {open && <div className="flex flex-col gap-3 border-t border-neutral-800 p-3">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------- avatar --

function AvatarSection({
  project,
  providers,
  avatars,
  loading,
  setAvatars,
  setAvatar,
}: {
  project: Project;
  providers: ProviderInfo[];
  avatars: AvatarOption[];
  loading: boolean;
  setAvatars: (l: AvatarOption[]) => void;
  setAvatar: (p: Partial<AvatarSettings>) => void;
}) {
  const api = useApi();
  const s = project.settings.avatar;
  const provider = providers.find((p) => p.kind === "avatar" && p.id === s.providerId);
  const custom = !!provider?.customCharacters;
  const [showAll, setShowAll] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);

  // Selected first, then the user's own characters, then the library.
  const ordered = useMemo(() => {
    const own = avatars.filter((a) => a.kind === "personal");
    const stock = avatars.filter((a) => a.kind !== "personal");
    const all = [...own, ...stock];
    const sel = all.find((a) => a.id === s.avatarId);
    return sel ? [sel, ...all.filter((a) => a !== sel)] : all;
  }, [avatars, s.avatarId]);
  const selected = avatars.find((a) => a.id === s.avatarId);
  const names = useMemo(() => distinctNames(avatars), [avatars]);

  // The character's source picks the HeyGen engine (video twin → Avatar III), so it is saved with it.
  // Unknown counts as a photo: that keeps the provider's default engine.
  const pick = (id: string) =>
    setAvatar({ enabled: true, avatarId: id, avatarSource: avatars.find((a) => a.id === id)?.source ?? "photo", layout: { ...s.layout, visible: true } });

  const upload = async (file: File) => {
    if (!s.providerId) return;
    setProgress(0);
    try {
      const created = await api.uploadAvatarCharacter(s.providerId, file, { onProgress: setProgress });
      invalidateAvatars(s.providerId);
      setAvatars(await api.listAvatars(s.providerId));
      pick(created.id);
      toast(t.settings.characterUploaded);
    } catch (err) {
      toast(`${t.settings.characterUploadFailed}：${errorMessage(err)}`, "error");
    } finally {
      setProgress(null);
    }
  };

  const remove = async () => {
    if (!s.providerId || !selected) return;
    if (!(await confirmAction({ title: fmt(t.settings.deleteCharacterConfirm, { name: selected.name }), lines: [], confirmLabel: t.common.remove, danger: true }))) return;
    try {
      await api.deleteAvatarCharacter(s.providerId, selected.id);
      invalidateAvatars(s.providerId);
      const list = await api.listAvatars(s.providerId);
      setAvatars(list);
      setAvatar({ avatarId: list[0]?.id });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  return (
    <Section
      title={t.studio.avatar}
      aside={
        avatars.length > GALLERY_COUNT ? (
          <button type="button" className="text-xs text-accent-300 hover:underline" onClick={() => setShowAll(true)}>
            {fmt(t.studio.showAll, { n: avatars.length })}
          </button>
        ) : undefined
      }
    >
      <ProviderPills providers={providers} kind="avatar" value={s.providerId} onChange={(providerId) => setAvatar({ providerId, enabled: true })} />
      {provider?.hint && <p className="text-xs text-amber-300/90">{provider.hint}</p>}
      <AvatarProviderCompare providers={providers} selected={s.enabled ? s.providerId : undefined} />
      <div className="grid grid-cols-4 gap-2" data-testid="avatar-gallery">
        {custom && (
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            disabled={progress !== null}
            className="flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-md border border-dashed border-neutral-600 text-xs text-neutral-300 hover:border-neutral-400"
          >
            {progress !== null ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            {progress !== null ? `${Math.round(progress * 100)}%` : t.studio.create}
          </button>
        )}
        <button
          type="button"
          aria-pressed={!s.enabled}
          onClick={() => setAvatar({ enabled: false })}
          title={t.studio.noAvatar}
          className={`flex aspect-[3/4] flex-col items-center justify-center gap-1 rounded-md border text-xs ${
            !s.enabled ? "border-accent-400 bg-accent-500/15 text-accent-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
          }`}
        >
          <Ban className="size-4" aria-hidden />
          {t.studio.noAvatar}
        </button>
        {loading && avatars.length === 0
          ? // As many placeholders as tiles to come (plus room for the stock heading): no jump on load.
            Array.from({ length: GALLERY_COUNT }, (_, i) => (
              <div key={i} className="aspect-[3/4] animate-pulse rounded-md bg-neutral-800" aria-hidden />
            ))
          : ordered.slice(0, GALLERY_COUNT).flatMap((a, i, list) => {
              const tile = (
                <AvatarTile
                  key={a.id}
                  a={a}
                  label={names.get(a.id) ?? a.name}
                  url={avatarImageUrl(api, s.providerId, a)}
                  selected={s.enabled && a.id === s.avatarId}
                  onPick={() => pick(a.id)}
                />
              );
              // Stock presenters start a group of their own, so they are not mistaken for the user's.
              const firstStock = a.kind !== "personal" && (i === 0 || list[i - 1]!.kind === "personal") && list.some((o) => o.kind === "personal");
              return firstStock
                ? [
                    <p key="stock-heading" className="col-span-full pt-1 text-xs text-neutral-400">
                      {s.providerId === "heygen" ? t.studio.stockHeygen : t.studio.stock}
                    </p>,
                    tile,
                  ]
                : [tile];
            })}
      </div>
      {loading && avatars.length === 0 && (
        <p className="flex items-center gap-1.5 text-xs text-neutral-400" role="status">
          <Loader2 className="size-3.5 animate-spin" aria-hidden /> {t.studio.loading}
        </p>
      )}
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
      {s.enabled && selected && (
        <div className="flex items-center justify-between gap-2 text-xs text-neutral-400">
          <span className="truncate">
            {t.studio.current}：<span className="text-neutral-200">{names.get(selected.id) ?? selected.name}</span>
            {s.providerId === "heygen" && (
              <span className="block text-xs text-neutral-400" data-testid="avatar-engine">
                {s.avatarSource === "video" ? t.studio.engineVideo : t.studio.enginePhoto}
              </span>
            )}
          </span>
          {selected.kind === "personal" && custom && (
            <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove()}>
              {t.settings.deleteCharacter}
            </Button>
          )}
        </div>
      )}
      {custom && <p className="text-xs text-neutral-400">{t.settings.uploadCharacterHint}</p>}
      <AllAvatarsModal
        open={showAll}
        onClose={() => setShowAll(false)}
        avatars={ordered}
        names={names}
        providerId={s.providerId}
        selectedId={s.enabled ? s.avatarId : undefined}
        onPick={(id) => {
          pick(id);
          setShowAll(false);
        }}
      />
    </Section>
  );
}

/** VoAI-style plan card: what each avatar provider gives (gestures, lips, cost, wait). */
function AvatarProviderCompare({ providers, selected }: { providers: ProviderInfo[]; selected: string | undefined }) {
  const ids = (["heygen", "local"] as const).filter((id) => providers.some((p) => p.kind === "avatar" && p.id === id));
  if (ids.length < 2) return null;
  const c = t.studio.compare;
  const rows = [
    [c.gestures, "gestures"],
    [c.lips, "lips"],
    [c.cost, "cost"],
    [c.wait, "wait"],
  ] as const;
  const name = (id: (typeof ids)[number]) => c[id].name;
  return (
    <div className="rounded-md border border-neutral-800 text-xs" data-testid="avatar-compare">
      <table className="w-full table-fixed border-collapse">
        <caption className="px-2 pt-1.5 pb-1 text-left text-xs font-medium text-neutral-300">{c.title}</caption>
        <thead>
          <tr className="text-neutral-400">
            <th className="w-[30%] px-2 py-1 text-left font-normal" />
            {ids.map((id) => (
              <th key={id} scope="col" className={`px-2 py-1 text-left font-medium ${selected === id ? "text-accent-200" : "text-neutral-200"}`}>
                {name(id)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, key]) => (
            <tr key={key} className="border-t border-neutral-800/70">
              <th scope="row" className="px-2 py-1 text-left font-normal text-neutral-400">
                {label}
              </th>
              {ids.map((id) => (
                <td key={id} className={`px-2 py-1 ${selected === id ? "bg-accent-500/10 text-neutral-100" : "text-neutral-300"}`}>
                  {c[id][key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-neutral-800/70 px-2 py-1.5 text-neutral-400">{c.tip}</p>
    </div>
  );
}

function AvatarTile({
  a,
  label,
  url,
  selected,
  onPick,
}: {
  a: AvatarOption;
  label: string;
  url: string | undefined;
  selected: boolean;
  onPick: () => void;
}) {
  const [broken, setBroken] = useState(false);
  // "Name #2" → the running number goes in the corner tag, where a two-line clamp can't cut it off.
  const m = /^(.*) (#\d+)$/.exec(label);
  const name = m ? m[1]! : label;
  const number = m ? m[2]! : "";
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      title={label}
      onClick={onPick}
      className={`group relative aspect-[3/4] overflow-hidden rounded-md border bg-neutral-800 ${
        selected ? "border-accent-400 ring-2 ring-accent-400/60" : "border-neutral-700 hover:border-neutral-500"
      }`}
    >
      {url && !broken ? (
        <img src={url} alt="" loading="lazy" className="size-full object-cover object-top" onError={() => setBroken(true)} />
      ) : (
        // No picture (or it failed to load): a figure, so the tile never looks like an empty slot.
        <span className="flex size-full items-center justify-center pb-6 text-neutral-400" aria-hidden>
          <UserRound className="size-7" />
        </span>
      )}
      {/* The user's own presenters already carry their type in the name (我的照片型人像 1). */}
      {a.kind !== "personal" && (a.source || number) && (
        <span className="absolute top-1 left-1 rounded on-dark bg-black/70 px-1 py-px text-xs leading-tight text-neutral-100">
          {[a.source ? t.studio.source[a.source] : "", number].filter(Boolean).join(" ")}
        </span>
      )}
      <span className="absolute inset-x-0 bottom-0 line-clamp-2 on-dark bg-black/75 px-1 py-0.5 text-xs leading-tight break-words text-neutral-100">{name}</span>
      {selected && (
        <span className="absolute top-1 right-1 rounded-full bg-accent-500 p-0.5 text-white">
          <Check className="size-3" aria-hidden />
        </span>
      )}
    </button>
  );
}

function AllAvatarsModal({
  open,
  onClose,
  avatars,
  names,
  providerId,
  selectedId,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  avatars: AvatarOption[];
  names: Map<string, string>;
  providerId: string | undefined;
  selectedId: string | undefined;
  onPick: (id: string) => void;
}) {
  const api = useApi();
  const [q, setQ] = useState("");
  // Hundreds of stock presenters bury the user's own: start with theirs when they have any.
  const [onlyMine, setOnlyMine] = useState(() => avatars.some((a) => a.kind === "personal"));
  const list = avatars.filter((a) => (!onlyMine || a.kind === "personal") && a.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Modal title={t.studio.allAvatars} open={open} onClose={onClose} width="w-[760px]">
      <div className="mb-3 flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute top-2 left-2 size-4 text-neutral-400" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t.studio.searchAvatars}
            className="h-8 w-full rounded-md border border-neutral-700 bg-neutral-950 pr-2 pl-8 text-sm text-neutral-100 outline-none focus:border-accent-400"
          />
        </div>
        <Toggle label={t.studio.onlyMine} checked={onlyMine} onChange={setOnlyMine} />
      </div>
      <div className="grid max-h-[60vh] grid-cols-6 gap-2 overflow-y-auto pr-1">
        {list.map((a) => (
          <AvatarTile
            key={a.id}
            a={a}
            label={names.get(a.id) ?? a.name}
            url={avatarImageUrl(api, providerId, a)}
            selected={a.id === selectedId}
            onPick={() => onPick(a.id)}
          />
        ))}
        {list.length === 0 && <p className="col-span-6 py-6 text-center text-sm text-neutral-400">{t.studio.noMatch}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------- layout --

function LayoutSection({
  project,
  setLayout,
  setAvatar,
  patch,
}: {
  project: Project;
  setLayout: (p: Partial<AvatarLayout>) => void;
  setAvatar: (p: Partial<AvatarSettings>) => void;
  patch: (s: SettingsPatch) => void;
}) {
  const s = project.settings;
  const layout = s.avatar.layout;
  const active = s.avatar.enabled ? matchLayoutPreset(layout) : "hidden";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Section title={t.studio.layout}>
      <div className="grid grid-cols-3 gap-2" data-testid="layout-presets">
        {LAYOUT_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={active === p.id}
            onClick={() =>
              p.layout.visible === false
                ? setAvatar({ layout: { ...layout, ...p.layout } })
                : setAvatar({ enabled: true, layout: { ...layout, ...p.layout } })
            }
            className={`flex flex-col items-center gap-1 rounded-md border p-1.5 text-xs ${
              active === p.id ? "border-accent-400 bg-accent-500/10 text-accent-100" : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
            }`}
          >
            <LayoutThumb layout={{ ...layout, ...p.layout } as AvatarLayout} background={s.backgroundColor ?? "#000000"} />
            {p.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-neutral-400">{t.studio.dragHint}</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t.studio.background}>
          <ColorInput label={t.studio.background} value={s.backgroundColor ?? "#000000"} onCommit={(backgroundColor) => patch({ backgroundColor })} />
        </Field>
        <Field label={t.settings.shape}>
          <Select value={layout.shape} options={[{ value: "circle", label: t.options.shape.circle }, { value: "rect", label: t.studio.shapeRect }]} onChange={(shape) => setLayout({ shape })} />
        </Field>
      </div>
      <Field label={t.settings.size}>
        <CommitRange label={t.settings.size} value={layout.size} min={0.1} max={1} step={0.01} format={pct} onCommit={(size) => setLayout({ size })} />
      </Field>
      {s.avatar.enabled && layout.visible !== false && layout.size < minReadableSize(layout) && (
        <p className="text-xs text-amber-300" role="note" data-testid="avatar-size-hint">
          {fmt(t.studio.sizeSmall, { min: pct(minReadableSize(layout)) })}
        </p>
      )}
      <Field label={t.studio.slideScale}>
        <CommitRange label={t.studio.slideScale} value={layout.slideScale ?? 1} min={0.5} max={1} step={0.01} format={pct} onCommit={(slideScale) => setLayout({ slideScale })} />
      </Field>
      {layout.x !== undefined && (
        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setLayout({ x: undefined, y: undefined })}>
          {t.studio.resetPosition}
        </Button>
      )}
    </Section>
  );
}

/**
 * Below this (fraction of the frame height) the mouth is a few pixels tall in a 1080p video:
 * a circle crops to the face, a half-body box shows much more than the face.
 */
export function minReadableSize(layout: Pick<AvatarLayout, "shape">): number {
  return layout.shape === "circle" ? 0.35 : 0.5;
}

/** Tiny SVG mock of a frame layout: slide rectangle + avatar silhouette. */
function LayoutThumb({ layout, background }: { layout: AvatarLayout; background: string }) {
  const W = 64;
  const H = 36;
  const ratio = 16 / 9;
  const scale = layout.visible ? (layout.slideScale ?? 1) : 1;
  const inset = (0.04 / ratio) * W;
  const sw = W * scale;
  const sh = H * scale;
  const sx = scale >= 1 ? 0 : layout.slideAlign === "left" ? inset : layout.slideAlign === "right" ? W - sw - inset : (W - sw) / 2;
  const sy = (H - sh) / 2;
  const ah = layout.size * H;
  const aw = (layout.shape === "circle" ? 1 : 0.75) * ah;
  let ax: number;
  let ay: number;
  if (layout.x !== undefined && layout.y !== undefined) {
    ax = Math.min(Math.max(layout.x * W - aw / 2, 0), W - aw);
    ay = Math.min(Math.max(layout.y * H - ah / 2, 0), H - ah);
  } else {
    const m = layout.margin * H;
    const [v, h] = layout.anchor.includes("-") ? layout.anchor.split("-") : ["center", layout.anchor];
    ax = h === "right" ? W - aw - m : m;
    ay = v === "top" ? m : v === "bottom" ? H - ah - m : (H - ah) / 2;
  }
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-sm" aria-hidden>
      <rect width={W} height={H} fill={background} />
      <rect x={sx} y={sy} width={sw} height={sh} fill="#e5e7eb" />
      <rect x={sx + sw * 0.1} y={sy + sh * 0.15} width={sw * 0.5} height={sh * 0.08} fill="#9ca3af" />
      <rect x={sx + sw * 0.1} y={sy + sh * 0.35} width={sw * 0.7} height={sh * 0.05} fill="#cbd5e1" />
      <rect x={sx + sw * 0.1} y={sy + sh * 0.48} width={sw * 0.6} height={sh * 0.05} fill="#cbd5e1" />
      {layout.visible &&
        (layout.shape === "circle" ? (
          <>
            <circle cx={ax + aw / 2} cy={ay + ah / 2} r={aw / 2} fill="#6366f1" />
            <circle cx={ax + aw / 2} cy={ay + ah * 0.42} r={aw * 0.17} fill="#e0e7ff" />
          </>
        ) : (
          <>
            <circle cx={ax + aw / 2} cy={ay + ah * 0.2} r={aw * 0.2} fill="#6366f1" />
            <rect x={ax + aw * 0.15} y={ay + ah * 0.38} width={aw * 0.7} height={ah * 0.62} rx={aw * 0.15} fill="#6366f1" />
          </>
        ))}
    </svg>
  );
}

// ----------------------------------------------------------------------- voice --

function VoiceSection({
  project,
  providers,
  voices,
  setVoices,
  setVoice,
}: {
  project: Project;
  providers: ProviderInfo[];
  voices: VoiceOption[];
  setVoices: (l: VoiceOption[]) => void;
  setVoice: (p: Partial<VoiceSettings>) => void;
}) {
  const api = useApi();
  const s = project.settings.voice;
  const provider = providers.find((p) => p.kind === "tts" && p.id === s.providerId);
  const language = project.settings.language === "en" ? "en" : "zh-TW";
  const player = useVoicePlayer();
  const fileInput = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const selected = voices.find((v) => v.id === s.voiceId);

  useEffect(() => player.stop, [s.providerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const upload = async (file: File) => {
    setProgress(0);
    try {
      const created = await api.uploadVoice(s.providerId, file, { onProgress: setProgress });
      const list = await api.listVoices(s.providerId);
      setVoices(list);
      setVoice({ voiceId: list.find((v) => v.id === created.id)?.id ?? created.id });
      toast(t.settings.voiceUploaded);
    } catch (err) {
      toast(`${t.settings.voiceUploadFailed}：${errorMessage(err)}`, "error");
    } finally {
      setProgress(null);
    }
  };
  // Rename in place: the name the user gave, without the 「我的聲音・」 prefix and engine suffix.
  const [renaming, setRenaming] = useState<string | null>(null);
  const baseName = (name: string) => name.replace(/^我的聲音・/, "").replace(/（[^（）]*）$/, "");
  const saveName = async () => {
    const name = renaming?.trim();
    if (!selected || !name) return;
    try {
      await api.renameVoice(s.providerId, selected.id, name);
      setVoices(await api.listVoices(s.providerId));
      setRenaming(null);
      toast(t.settings.voiceRenamed, "success");
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const remove = async () => {
    if (!selected) return;
    if (!(await confirmAction({ title: fmt(t.settings.deleteVoiceConfirm, { name: selected.name }), lines: [], confirmLabel: t.common.remove, danger: true }))) return;
    try {
      await api.deleteVoice(s.providerId, selected.id);
      const list = await api.listVoices(s.providerId);
      setVoices(list);
      setVoice({ voiceId: list[0]?.id ?? "" });
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };

  // Voices that cannot speak the project's language (a Chinese-only clone in an English project,
  // 台語 voices…) are tucked away unless asked for; the chosen one always stays visible.
  const [showOther, setShowOther] = useState(false);
  const speaks = (v: VoiceOption) => !v.languages?.length || v.languages.includes(language);
  const shownVoices = voices.filter((v) => showOther || speaks(v) || v.id === s.voiceId);
  const otherCount = voices.length - voices.filter((v) => speaks(v) || v.id === s.voiceId).length;

  // The chosen voice may sit below the list's fold: bring it into view so it is visible at a glance.
  const voiceList = useRef<HTMLUListElement>(null);
  useEffect(() => {
    // Scroll the list itself only: scrollIntoView would also scroll the whole tab and hide the
    // presenter choice at the top.
    const ul = voiceList.current;
    const el = ul?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!ul || !el) return;
    const top = el.getBoundingClientRect().top - ul.getBoundingClientRect().top + ul.scrollTop;
    if (top < ul.scrollTop || top + el.offsetHeight > ul.scrollTop + ul.clientHeight) ul.scrollTop = Math.max(0, top - (ul.clientHeight - el.offsetHeight) / 2);
  }, [s.voiceId, voices.length]);

  return (
    <Section title={t.studio.voice}>
      <ProviderPills providers={providers} kind="tts" value={s.providerId} onChange={(providerId) => setVoice({ providerId })} />
      {provider?.hint && <p className="text-xs text-amber-300/90">{provider.hint}</p>}
      <ul ref={voiceList} className="max-h-64 overflow-y-auto rounded-md border border-neutral-800" role="listbox" aria-label={t.settings.voiceId} data-testid="voice-list">
        {shownVoices.map((v) => {
          const isSel = v.id === s.voiceId;
          const state = player.playingId === v.id ? player.state : "idle";
          return (
            <li
              key={v.id}
              role="option"
              aria-selected={isSel}
              className={`flex items-center gap-2 border-b border-neutral-800/70 px-2 py-1.5 last:border-b-0 ${isSel ? "bg-accent-500/15" : "hover:bg-neutral-800/60"}`}
            >
              <button
                type="button"
                aria-label={`${t.settings.previewVoice} ${v.name}`}
                onClick={() => void player.toggle(v.id, () => api.previewVoice(s.providerId, v.id, language))}
                className="flex size-7 shrink-0 items-center justify-center rounded-full border border-neutral-600 text-neutral-200 hover:border-accent-400"
              >
                {state === "loading" ? <Loader2 className="size-3.5 animate-spin" /> : state === "playing" ? <Square className="size-3" /> : <Play className="size-3.5" />}
              </button>
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setVoice({ voiceId: v.id })}>
                <div className="truncate text-sm text-neutral-100">
                  {v.name}
                  {!speaks(v) && (
                    <span className="ml-1 rounded bg-amber-500/15 px-1 text-xs text-amber-300">
                      {fmt(t.studio.voiceOnly, { lang: v.languages!.map((l) => t.translate.langName[l]).join("／") })}
                    </span>
                  )}
                </div>
                {voiceTagLabels(v.tags).length > 0 && <div className="truncate text-xs text-neutral-400">{voiceTagLabels(v.tags)
                    .slice(0, 3)
                    .join("・")}</div>}
              </button>
              {isSel && <Check className="size-4 shrink-0 text-accent-300" aria-hidden />}
            </li>
          );
        })}
        {voices.length === 0 && <li className="px-3 py-4 text-center text-xs text-neutral-400">{provider?.customVoices ? t.settings.noCustomVoices : t.app.loading}</li>}
      </ul>
      {otherCount > 0 && (
        <button type="button" className="self-start text-xs text-accent-300 hover:underline" aria-pressed={showOther} onClick={() => setShowOther((v) => !v)}>
          {showOther ? t.studio.hideOtherVoices : fmt(t.studio.showOtherVoices, { n: otherCount })}
        </button>
      )}
      {provider?.customVoices && (
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
          <Button size="sm" icon={progress === null ? Plus : Loader2} disabled={progress !== null} onClick={() => fileInput.current?.click()}>
            {progress === null ? t.settings.uploadVoice : `${t.settings.uploadingVoice} ${Math.round(progress * 100)}%`}
          </Button>
          {selected?.name.startsWith("我的聲音") && renaming === null && (
            <>
              <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setRenaming(baseName(selected.name))}>
                {t.settings.renameVoice}
              </Button>
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void remove()}>
                {t.settings.deleteVoice}
              </Button>
            </>
          )}
          {selected && renaming !== null && (
            <form
              className="flex w-full items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void saveName();
              }}
            >
              <input
                autoFocus
                value={renaming}
                maxLength={80}
                aria-label={t.settings.voiceName}
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setRenaming(null);
                  }
                }}
                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs"
                data-testid="voice-rename-input"
              />
              <Button size="sm" type="submit" disabled={!renaming.trim()}>
                {t.common.save}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setRenaming(null)}>
                {t.common.cancel}
              </Button>
            </form>
          )}
        </div>
      )}
      <Field label={t.settings.speed}>
        <CommitRange label={t.settings.speed} value={s.speed} min={0.5} max={2} step={0.05} format={(v) => `${v.toFixed(2)}×`} onCommit={(speed) => setVoice({ speed })} />
      </Field>
      <Field label={t.settings.sentencePause}>
        <CommitRange
          label={t.settings.sentencePause}
          value={s.sentencePauseSec}
          min={0}
          max={3}
          step={0.1}
          format={(v) => `${v.toFixed(1)} 秒`}
          onCommit={(sentencePauseSec) => setVoice({ sentencePauseSec })}
        />
      </Field>
    </Section>
  );
}

/** One preview at a time across the voice list. */
function useVoicePlayer() {
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  const url = useRef<string | null>(null);
  const token = useRef(0);
  const stop = () => {
    token.current++;
    audio.current?.pause();
    audio.current = null;
    if (url.current) URL.revokeObjectURL(url.current);
    url.current = null;
    setPlayingId(null);
    setState("idle");
  };
  useEffect(() => stop, []); // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = async (id: string, fetchBlob: () => Promise<Blob>) => {
    if (playingId === id) return stop();
    stop();
    const my = ++token.current;
    setPlayingId(id);
    setState("loading");
    try {
      const blob = await fetchBlob();
      if (my !== token.current) return;
      url.current = URL.createObjectURL(blob);
      const a = new Audio(url.current);
      audio.current = a;
      a.onended = stop;
      a.onerror = () => {
        toast(t.settings.previewFailed, "error");
        stop();
      };
      // Show "playing" once the audio is ready; play() can stay pending in a background tab.
      setState("playing");
      a.play().catch((err: unknown) => {
        if (my !== token.current) return;
        toast(`${t.settings.previewFailed}：${errorMessage(err)}`, "error");
        stop();
      });
    } catch (err) {
      if (my !== token.current) return;
      toast(`${t.settings.previewFailed}：${errorMessage(err)}`, "error");
      stop();
    }
  };
  return { playingId, state, toggle, stop };
}

// -------------------------------------------------------------------- subtitles --

function SubtitleSection({
  project,
  setSubtitles,
  setStyle,
}: {
  project: Project;
  setSubtitles: (p: Partial<SubtitleSettings>) => void;
  setStyle: (p: Partial<SubtitleStyle>) => void;
}) {
  const sub = project.settings.subtitles;
  const style = sub.style;
  const active = matchSubtitlePreset(style);
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return (
    <Section title={t.studio.subtitles}>
      <div className="grid grid-cols-2 gap-3">
        <Toggle label={t.settings.subtitlesEnabled} checked={sub.enabled} onChange={(enabled) => setSubtitles({ enabled })} />
        <Toggle label={t.settings.burnIn} checked={sub.burnIn} disabled={!sub.enabled} onChange={(burnIn) => setSubtitles({ burnIn })} />
      </div>
      <div className="grid grid-cols-3 gap-2" data-testid="subtitle-presets">
        {SUBTITLE_PRESETS.map((p) => {
          const preview = { ...style, ...p.style } as SubtitleStyle;
          return (
            <button
              key={p.id}
              type="button"
              aria-pressed={active === p.id}
              disabled={!sub.enabled}
              onClick={() => setStyle(p.style)}
              className={`flex flex-col items-center gap-1 rounded-md border p-1.5 text-xs disabled:opacity-40 ${
                active === p.id ? "border-accent-400 bg-accent-500/10 text-accent-100" : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
            >
              <span className="flex h-9 w-full items-center justify-center rounded-sm bg-gradient-to-br from-slate-400 to-slate-600">
                <span className="rounded px-1 text-xs leading-tight" style={subtitleCss({ ...preview, fontSizePx: 11 }, (px) => `${px}px`)}>
                  {t.studio.captionSample[project.settings.language === "en" ? "en" : "zh"]}
                </span>
              </span>
              {p.label}
            </button>
          );
        })}
      </div>
      <Disclosure label={t.studio.subtitleDetails}>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.settings.fontSize}>
            <CommitNumber label={t.settings.fontSize} value={style.fontSizePx} min={10} max={120} onCommit={(v) => v !== undefined && setStyle({ fontSizePx: v })} />
          </Field>
          <Field label={t.settings.maxChars}>
            <CommitNumber label={t.settings.maxChars} value={style.maxCharsPerLine} min={8} max={80} onCommit={(v) => v !== undefined && setStyle({ maxCharsPerLine: v })} />
          </Field>
          <Field label={t.settings.color}>
            <ColorInput label={t.settings.color} value={style.color} onCommit={(color) => setStyle({ color })} />
          </Field>
          <Field label={t.settings.background}>
            <ColorInput label={t.settings.background} value={style.backgroundColor} onCommit={(backgroundColor) => setStyle({ backgroundColor })} />
          </Field>
          <Field label={t.studio.outlineColor}>
            <ColorInput label={t.studio.outlineColor} value={style.outlineColor ?? "#000000"} onCommit={(outlineColor) => setStyle({ outlineColor })} />
          </Field>
          <Field label={t.settings.position}>
            <Select
              value={style.position}
              options={[
                { value: "bottom", label: t.options.position.bottom },
                { value: "top", label: t.options.position.top },
              ]}
              onChange={(position) => setStyle({ position })}
            />
          </Field>
        </div>
        <Field label={t.settings.bgOpacity}>
          <CommitRange label={t.settings.bgOpacity} value={style.backgroundOpacity} min={0} max={1} step={0.05} format={pct} onCommit={(backgroundOpacity) => setStyle({ backgroundOpacity })} />
        </Field>
        <Field label={t.studio.outlineWidth}>
          <CommitRange
            label={t.studio.outlineWidth}
            value={style.outlineWidthPx ?? 0}
            min={0}
            max={8}
            step={1}
            format={(v) => `${v}px`}
            onCommit={(outlineWidthPx) => setStyle({ outlineWidthPx: Math.round(outlineWidthPx) })}
          />
        </Field>
        <Toggle label={t.studio.bold} checked={!!style.bold} onChange={(bold) => setStyle({ bold })} />
      </Disclosure>
    </Section>
  );
}

/** Chinese labels for a voice's vendor tags ("middle_aged" → 中年); tags without one are left out. */
export function voiceTagLabels(tags: string[] | undefined): string[] {
  const table = t.studio.voiceTags as Record<string, string>;
  const out = (tags ?? []).map((tag) => table[tag.trim().toLowerCase().replace(/[\s-]+/g, "_")]).filter((x): x is string => !!x);
  return [...new Set(out)];
}
