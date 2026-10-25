import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { avatarInVideo, effectiveReadings, usesGlossaryTerm } from "@lvs/shared";
import type { ScriptRevision } from "@lvs/shared";
import { AlertTriangle, ChevronRight, Redo2, Undo2, Volume2, VolumeX, WandSparkles } from "lucide-react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { twdShort } from "../../lib/paidJobs";
import { countChars, estimateSpeechSeconds } from "../../lib/scenes";
import { currentScript, useEditor, type SaveState } from "../../store/editorStore";
import { toast } from "../../store/toastStore";
import { Button, IconButton } from "../ui/Button";
import { Spinner } from "../ui/Misc";
import { usePendingEstimate } from "../../hooks/usePendingEstimate";
import { RewriteDialog } from "./RewriteDialog";
import { ScriptHistory } from "./ScriptHistory";
import { openEditorTab } from "./RightPanel";

export const SCRIPT_MAX_CHARS = 5000;
/** HeyGen API price per avatar second (pipeline price table): video twin (Avatar III) / photo (Avatar IV). */
const HEYGEN_USD_PER_SEC = { video: 0.0167, photo: 0.05 } as const;

export interface ScriptPanelProps {
  actions: Pick<EditorActions, "enqueue" | "saveScript" | "updateScene">;
}

export function ScriptPanel({ actions }: ScriptPanelProps) {
  const detail = useEditor((s) => s.detail);
  const sceneId = useEditor((s) => s.selectedSceneId);
  const drafts = useEditor((s) => s.drafts);
  const history = useEditor((s) => (sceneId ? s.history[sceneId] : undefined));
  const saveState = useEditor((s) => (sceneId ? s.saveState[sceneId] : undefined));
  const editScript = useEditor((s) => s.editScript);
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const [focused, setFocused] = useState(false);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  // Each opening asks the server afresh (settings may have changed since the last time).
  const [rewriteAsk, setRewriteAsk] = useState(0);
  // No answer (server unreachable): don't hold the button forever.
  const [askGaveUp, setAskGaveUp] = useState(0);
  useEffect(() => {
    if (!rewriteOpen) return;
    const id = setTimeout(() => setAskGaveUp(rewriteAsk), 5000);
    return () => clearTimeout(id);
  }, [rewriteOpen, rewriteAsk]);

  const scene = useMemo(() => detail?.scenes.find((s) => s.id === sceneId), [detail, sceneId]);
  // The server's price for redoing this page's avatar, so every screen shows the same number
  // (the local table is only a fallback while it loads). Hooks first, before the early return.
  const av = detail?.project.settings.avatar;
  const paidAvatarReady = !!scene && !!av && av.enabled && !!av.avatarId && av.providerId !== "local" && !scene.muted && scene.avatar.status === "ready";
  const serverRedo = usePendingEstimate(paidAvatarReady ? detail?.project.id : undefined, "generate_avatar", `${av?.avatarId}:${scene?.durationSec}`, "all", scene ? [scene.id] : undefined);
  // Whether 「AI 重寫本頁」 would plan a new outline first (the server decides, as the job will).
  const rewriteEstimate = usePendingEstimate(
    rewriteOpen ? detail?.project.id : undefined,
    "generate_script",
    `${rewriteAsk}:${detail?.outline?.id}:${detail?.project.updatedAt}:${detail?.slides.map((s) => (s.hidden ? 1 : 0)).join("")}`,
    "all",
    scene ? [scene.id] : undefined,
    true,
  );
  if (!detail || !scene) {
    const status = detail?.sourceDocument?.parseStatus;
    const parseJob = detail?.activeJobs.some((j) => j.type === "parse_document");
    const notParsing = status === "failed" || status === "cancelled" || ((status === "queued" || status === "running") && !parseJob);
    return (
      <p className="p-4 text-sm text-neutral-400">
        {detail && detail.slides.length === 0 ? (status === "failed" ? t.editor.parseFailedPanel : notParsing ? t.editor.parseStoppedPanel : t.editor.waitForSlides) : t.editor.selectPage}
      </p>
    );
  }

  const text = currentScript({ detail, drafts }, scene.id);
  const revision = detail.scripts[scene.id];
  const glossaryHits = effectiveReadings(detail.outline?.glossary ?? []).filter((g) => usesGlossaryTerm(text, g.term));
  const hasDraft = drafts[scene.id] !== undefined;
  const settings = detail.project.settings;
  const seconds = estimateSpeechSeconds(text, settings.language, settings.voice.speed);
  // The server doesn't mark pages 「generating」: a script/translation job covering this page counts
  // (an explicit page list, a forced 「全部」, or 補齊 for a page that has no script yet). Its result
  // would replace whatever is typed meanwhile, so the box is locked until it's done.
  const coveredByJob = detail.activeJobs.some((j) => {
    if (j.type !== "generate_script" && j.type !== "translate_script") return false;
    const p = j.payload as { sceneIds?: string[]; force?: boolean };
    if (p.sceneIds?.length) return p.sceneIds.includes(scene.id);
    return j.type === "translate_script" || !!p.force || scene.script.status === "missing" || scene.script.status === "failed";
  });
  const generating = scene.script.status === "generating" || scene.script.status === "queued" || coveredByJob;
  const noScript = !text.trim();
  const needs = (st: { status: string }) => st.status === "stale" || st.status === "failed";
  // A hidden page is not in the video: never offer to pay for its narration or presenter.
  const hidden = detail.slides.find((sl) => sl.id === scene.slideId)?.hidden ?? false;
  const audioNeeds = !hidden && !scene.muted && !!revision && (needs(scene.audio) || scene.audio.status === "missing");
  const avatarOn = avatarInVideo(settings.avatar);
  const avatarNeeds = !hidden && avatarOn && !scene.muted && !!revision && (needs(scene.avatar) || scene.avatar.status === "missing");
  const busy = (type: string) => detail.activeJobs.some((j) => j.type === type);
  // A finished paid avatar is lip-synced to this exact text: say so before the first keystroke
  // (paidAvatarReady above).
  const redoCost = serverRedo
    ? twdShort(serverRedo.total, serverRedo.currency)
    : twdShort((scene.durationSec ?? seconds) * HEYGEN_USD_PER_SEC[settings.avatar.avatarSource === "video" ? "video" : "photo"]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if ((key === "z" && e.shiftKey) || key === "y") {
      e.preventDefault();
      redo(scene.id);
    } else if (key === "z") {
      e.preventDefault();
      undo(scene.id);
    }
  };

  const rewrite = async (instruction: string | undefined) => {
    setRewriteOpen(false);
    // The dialog already said what is replaced and what it costs; a one-page script needs no second ask.
    const job = await actions.enqueue({ type: "generate_script", sceneIds: [scene.id], force: true, ...(instruction ? { instruction } : {}) }, { confirm: false });
    if (job) toast(t.script.aiRewriteQueued);
  };
  const sourceLabel = (source: ScriptRevision["source"]) =>
    source === "ai" ? t.script.sourceAi : source === "translation" ? t.script.sourceTranslation : t.script.sourceUser;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4">
      <div className="relative flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-neutral-100">{fmt(t.script.heading, { n: scene.index + 1 })}</h2>
          {revision && (
            <p className="text-xs text-neutral-400">
              {fmt(t.script.revisionInfo, {
                v: revision.version,
                source: sourceLabel(revision.source),
              })}
            </p>
          )}
        </div>
        <div className="flex items-center gap-1">
          <ScriptHistory
            projectId={detail.project.id}
            sceneId={scene.id}
            currentVersion={revision?.version}
            currentText={text}
            // Through the editor (undoable, autosaved) like any edit.
            onRestore={(old) => editScript(scene.id, old)}
          />
          <SaveIndicator state={saveState} hasDraft={hasDraft} onRetry={() => void actions.saveScript(scene.id, text)} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <Button size="sm" icon={WandSparkles} onClick={() => {
            setRewriteAsk((n) => n + 1);
            setRewriteOpen(true);
          }} disabled={generating} data-testid="ai-rewrite">
          {noScript ? t.script.aiWrite : t.script.aiRewrite}
        </Button>
        <RewriteDialog
          open={rewriteOpen}
          page={scene.index + 1}
          userEdited={revision?.source === "user"}
          fresh={noScript}
          avatarCost={paidAvatarReady ? redoCost : undefined}
          replansOutline={!!rewriteEstimate?.replansOutline}
          checking={!rewriteEstimate && askGaveUp !== rewriteAsk}
          onClose={() => setRewriteOpen(false)}
          onRewrite={(instruction) => void rewrite(instruction)}
        />
        <Button
          size="sm"
          variant={scene.muted ? "primary" : "secondary"}
          icon={scene.muted ? VolumeX : Volume2}
          aria-pressed={scene.muted}
          onClick={() => void actions.updateScene(scene.id, { muted: !scene.muted })}
        >
          {scene.muted ? t.pageList.unmute : t.pageList.mute}
        </Button>
        <div className="ml-auto flex">
          <IconButton icon={Undo2} label={t.script.undo} disabled={!history?.past.length} onClick={() => undo(scene.id)} />
          <IconButton icon={Redo2} label={t.script.redo} disabled={!history?.future.length} onClick={() => redo(scene.id)} />
        </div>
      </div>

      {paidAvatarReady && (focused || hasDraft) && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-100" role="note" data-testid="edit-warning">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {fmt(t.script.editWarnAvatar, { cost: redoCost })}
        </p>
      )}

      <div className="relative min-h-[200px] flex-1">
        <textarea
          aria-label={fmt(t.script.heading, { n: scene.index + 1 })}
          className="size-full resize-none rounded-md border border-neutral-700 bg-neutral-950 p-3 text-sm leading-relaxed text-neutral-100 placeholder:text-neutral-600 focus:border-accent-500 focus:outline-none read-only:opacity-60"
          value={text}
          placeholder={t.script.placeholder}
          maxLength={SCRIPT_MAX_CHARS}
          readOnly={generating}
          onChange={(e) => editScript(scene.id, e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        {generating && (
          <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
            <span className="flex items-center gap-2 rounded-full bg-neutral-800 px-3 py-1 text-xs text-neutral-200 shadow">
              <Spinner className="size-3.5" /> {t.status[scene.script.status]}
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between text-xs text-neutral-400">
        <span className={countChars(text) > SCRIPT_MAX_CHARS * 0.95 ? "text-amber-300" : ""}>
          {fmt(t.script.chars, { n: countChars(text), max: SCRIPT_MAX_CHARS })}
        </span>
        {/* Once there is narration, its real length; before that, the estimate from the text. */}
        <span>{scene.durationSec && scene.audio.status === "ready" && !hasDraft ? fmt(t.script.audioSeconds, { n: Math.round(scene.durationSec) }) : fmt(t.script.estSeconds, { n: seconds })}</span>
      </div>

      {(audioNeeds || avatarNeeds) && !hasDraft && (
        <div className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100" data-testid="stale-hint">
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <div className="flex flex-col gap-0.5">
              {audioNeeds && <span>{scene.audio.status === "missing" ? `${t.status.audio}${t.status.missing}。` : t.script.staleAudio}</span>}
              {avatarNeeds && <span>{scene.avatar.status === "missing" ? t.script.missingAvatar : t.script.staleAvatar}</span>}
            </div>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {audioNeeds && (
              <Button
                size="sm"
                disabled={busy("synthesize_speech")}
                onClick={() => void actions.enqueue({ type: "synthesize_speech", sceneIds: [scene.id], force: false })}
              >
                {scene.audio.status === "missing" ? t.script.makeAudio : t.script.redoAudio}
              </Button>
            )}
            {avatarNeeds && (
              <Button
                size="sm"
                disabled={busy("generate_avatar")}
                onClick={() => void actions.enqueue({ type: "generate_avatar", sceneIds: [scene.id], force: false })}
              >
                {scene.avatar.status === "missing" ? t.script.makeAvatar : t.script.redoAvatar}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Why the page list says 講稿需更新, and what (not) to do about it. */}
      {!generating && scene.script.status === "stale" && revision?.source === "ai" && (
        <p className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-2 text-xs text-sky-100" data-testid="script-stale-hint">
          {t.script.staleScript}
        </p>
      )}
      {/* A hand-written or translated script kept through a deck replacement onto a changed slide. */}
      {!generating && scene.script.status === "stale" && revision && revision.source !== "ai" && (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-xs text-amber-100" data-testid="script-slide-changed-hint">
          {t.script.staleSlideChanged}{" "}
          <button type="button" className="font-medium text-amber-200 underline hover:text-amber-50" onClick={() => void actions.saveScript(scene.id, text)}>
            {t.script.confirmFits}
          </button>
        </p>
      )}
      {!generating && noScript && !hidden && (
        <p className="rounded-md border border-neutral-700 px-2.5 py-2 text-xs text-neutral-300" data-testid="script-missing-hint">
          {t.script.noScriptHint}
        </p>
      )}
      {hidden && (
        <p className="rounded-md border border-neutral-700 px-2.5 py-2 text-xs text-neutral-300" data-testid="hidden-hint">
          {t.script.hiddenPage}
        </p>
      )}

      {/* Narration differs from the script here (glossary readings): say so where it is visible. */}
      {glossaryHits.length > 0 && (
        <p className="text-xs text-neutral-400" data-testid="glossary-applied">
          {fmt(t.script.glossaryApplied, { list: glossaryHits.map((g) => `${g.term} → ${g.reading}`).join("、") })}{" "}
          <button type="button" className="text-accent-300 hover:underline" onClick={() => openEditorTab("outline")}>
            {t.script.glossaryFix}
          </button>
        </p>
      )}
      <DerivedTexts revision={revision} pending={hasDraft} />
    </div>
  );
}

function SaveIndicator({ state, hasDraft, onRetry }: { state: SaveState | undefined; hasDraft: boolean; onRetry: () => void }) {
  if (state?.status === "error") {
    return (
      <button
        type="button"
        onClick={onRetry}
        className="text-xs text-rose-300 underline-offset-2 hover:underline"
        title={t.app.retry}
      >
        {fmt(t.script.saveFailed, { message: state.error ?? "" })}
      </button>
    );
  }
  if (state?.status === "saving") {
    return (
      <span className="flex items-center gap-1 text-xs text-neutral-400">
        <Spinner className="size-3" /> {t.script.saving}
      </span>
    );
  }
  if (hasDraft) return <span className="text-xs text-amber-300">{t.script.unsaved}</span>;
  return <span className="text-xs text-neutral-400">{t.script.saved}</span>;
}

function DerivedTexts({ revision, pending }: { revision: ScriptRevision | undefined; pending: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-neutral-800">
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-neutral-300 hover:text-neutral-100"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight className={`size-3.5 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden />
        {t.script.derived}
        {pending && <span className="ml-auto font-normal text-neutral-400">{t.script.derivedPending}</span>}
      </button>
      {open && (
        <div className="flex max-h-56 flex-col gap-3 overflow-y-auto border-t border-neutral-800 px-2.5 py-2">
          <ReadOnlyText label={t.script.pronunciation} text={revision?.pronunciationText} />
          <button type="button" className="self-start text-xs text-accent-300 hover:underline" onClick={() => openEditorTab("outline")} data-testid="fix-reading">
            {t.script.fixReading}
          </button>
          <ReadOnlyText label={t.script.subtitle} text={revision?.subtitleText} />
        </div>
      )}
    </div>
  );
}

function ReadOnlyText({ label, text }: { label: string; text: string | undefined }) {
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-neutral-400">{label}</div>
      <p className="text-xs leading-relaxed whitespace-pre-wrap text-neutral-300">{text || t.script.derivedEmpty}</p>
    </div>
  );
}
