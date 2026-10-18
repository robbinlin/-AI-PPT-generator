import { useState, type FormEvent } from "react";
import type { AspectRatio, CreateProjectRequest, Language } from "@lvs/shared";
import { errorMessage } from "../../api/types";
import { fmt, t } from "../../i18n";
import { Button } from "../ui/Button";
import { Field, Select, TextInput } from "../ui/Field";
import { Modal } from "../ui/Modal";

const LANGUAGES: Language[] = ["zh-TW", "en", "mixed"];
const RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1"];

export interface NewProjectDialogProps {
  open: boolean;
  onClose: () => void;
  onCreate: (req: CreateProjectRequest) => Promise<void>;
}

export function NewProjectDialog({ open, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState<Language>("zh-TW");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim() || t.projects.defaultName, settings: { language, aspectRatio } });
      setName("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.projects.dialogTitle}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" type="submit" form="new-project-form" disabled={busy}>
            {t.common.create}
          </Button>
        </>
      }
    >
      <form id="new-project-form" className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t.projects.name}>
          <TextInput
            value={name}
            maxLength={200}
            placeholder={t.projects.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.projects.language}>
            <Select
              value={language}
              onChange={setLanguage}
              options={LANGUAGES.map((v) => ({ value: v, label: t.languages[v] }))}
            />
          </Field>
          <Field label={t.projects.aspectRatio}>
            <Select
              value={aspectRatio}
              onChange={setAspectRatio}
              options={RATIOS.map((v) => ({ value: v, label: t.aspectRatios[v] }))}
            />
          </Field>
        </div>
        <p className="text-xs text-neutral-500">{t.projects.uploadHint}</p>
        {error && <p className="text-xs text-rose-300">{fmt(t.app.error, { message: error })}</p>}
      </form>
    </Modal>
  );
}
