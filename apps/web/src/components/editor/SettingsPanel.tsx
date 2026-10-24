import type {
  AspectRatio,
  Audience,
  ContentBoundary,
  Language,
  ProviderInfo,
  ScriptMode,
  Transition,
  UpdateProjectRequest,
} from "@lvs/shared";
import { Languages } from "lucide-react";
import type { EditorActions } from "../../hooks/useEditorActions";
import { useStudioLists } from "../../hooks/useStudioLists";
import { useTranslateProject } from "../../hooks/useTranslateProject";
import { Button } from "../ui/Button";
import { t } from "../../i18n";
import { useEditor } from "../../store/editorStore";
import { Field, Select, type Option } from "../ui/Field";
import { CommitNumber, CommitText, SettingsSection } from "./settingsFields";

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

export function SettingsPanel({
  actions,
}: {
  actions: Pick<EditorActions, "updateProject" | "changeSettings">;
}) {
  const project = useEditor((s) => s.detail?.project);
  const hasSlides = useEditor((s) => (s.detail?.slides.length ?? 0) > 0);
  const { providers } = useStudioLists(project, actions);
  const translate = useTranslateProject();
  if (!project) return null;
  const s = project.settings;
  const patch = (settings: SettingsPatch) =>
    void actions.updateProject({ settings });

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
        {s.language !== "en" && hasSlides && (
          <div className="flex items-center gap-2 rounded-md border border-neutral-800 px-3 py-2">
            <Languages className="size-4 shrink-0 text-neutral-400" aria-hidden />
            <p className="flex-1 text-xs text-neutral-400">{t.projects.translateHint}</p>
            <Button size="sm" onClick={() => void translate({ id: project.id, name: project.name })} data-testid="translate-project">
              {t.translate.settingsButton}
            </Button>
          </div>
        )}
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
              onChange={(aspectRatio) => void actions.changeSettings({ aspectRatio }, "avatar")}
            />
          </Field>
        </div>
        <p className="text-[11px] text-neutral-500">{t.settings.studioMoved}</p>
      </SettingsSection>
    </div>
  );
}
