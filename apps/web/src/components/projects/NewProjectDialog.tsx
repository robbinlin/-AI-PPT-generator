import { useEffect, useRef, useState, type FormEvent } from "react";
import type { AspectRatio, CreateProjectRequest, Language } from "@lvs/shared";
import { FileUp, X } from "lucide-react";
import { errorMessage } from "../../api/types";
import { ACCEPTED_EXTENSIONS, validateUpload } from "../../hooks/useEditorActions";
import { t } from "../../i18n";
import { formatBytes } from "../../lib/format";
import { nameFromFile } from "../../lib/pendingUpload";
import { Button, IconButton } from "../ui/Button";
import { Field, Select, TextInput } from "../ui/Field";
import { Modal } from "../ui/Modal";

const LANGUAGES: Language[] = ["zh-TW", "en", "mixed"];
const RATIOS: AspectRatio[] = ["16:9", "9:16", "1:1"];

export interface NewProjectDialogProps {
  open: boolean;
  /** A deck dropped on the projects page before the dialog opened. */
  initialFile?: File | null;
  onClose: () => void;
  onCreate: (req: CreateProjectRequest, file: File | null) => Promise<void>;
}

/** New project in one step: pick the deck here (name defaults to its file name), or add it later. */
export function NewProjectDialog({ open, initialFile, onClose, onCreate }: NewProjectDialogProps) {
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [language, setLanguage] = useState<Language>("zh-TW");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const choose = (f: File | null | undefined) => {
    if (!f) return;
    const invalid = validateUpload(f);
    if (invalid) {
      setError(invalid);
      return;
    }
    setError(null);
    setFile(f);
    // The 選擇檔案 button is replaced by the file row: move focus on to 建立並上傳.
    setTimeout(() => document.querySelector<HTMLElement>("[data-testid=create-project]")?.focus(), 0);
  };

  useEffect(() => {
    if (open && initialFile) choose(initialFile);
    if (!open) {
      setFile(null);
      setError(null);
    }
  }, [open, initialFile]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onCreate({ name: name.trim() || (file ? nameFromFile(file) : "") || t.projects.defaultName, settings: { language, aspectRatio } }, file);
      setName("");
      setFile(null);
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
          <Button variant="primary" type="submit" form="new-project-form" disabled={busy} data-testid="create-project">
            {file ? t.projects.createAndUpload : t.common.create}
          </Button>
        </>
      }
    >
      <form id="new-project-form" className="flex flex-col gap-4" onSubmit={submit}>
        <div
          className={`flex items-center gap-3 rounded-md border-2 border-dashed px-3 py-3 text-sm ${dragging ? "border-accent-400 bg-accent-500/10" : "border-neutral-700"}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            choose(e.dataTransfer.files[0]);
          }}
          data-testid="new-project-drop"
        >
          <FileUp className="size-5 shrink-0 text-neutral-400" aria-hidden />
          {file ? (
            <>
              <span className="min-w-0 flex-1 truncate text-neutral-100" title={file.name}>
                {file.name} <span className="text-xs text-neutral-400">· {formatBytes(file.size)}</span>
              </span>
              <IconButton icon={X} label={t.projects.removeFile} onClick={() => setFile(null)} />
            </>
          ) : (
            <>
              <span className="flex-1 text-xs text-neutral-400">{t.projects.dropHint}</span>
              <Button size="sm" onClick={() => input.current?.click()} data-autofocus>
                {t.upload.choose}
              </Button>
            </>
          )}
          <input
            ref={input}
            type="file"
            hidden
            accept={ACCEPTED_EXTENSIONS.join(",")}
            onChange={(e) => {
              choose(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <Field label={t.projects.name}>
          <TextInput
            value={name}
            maxLength={200}
            placeholder={file ? nameFromFile(file) : t.projects.namePlaceholder}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t.projects.language}>
            <Select value={language} onChange={setLanguage} options={LANGUAGES.map((v) => ({ value: v, label: t.languages[v] }))} />
            {language === "mixed" && <p className="mt-1 text-xs text-neutral-400">{t.projects.mixedHint}</p>}
          </Field>
          <Field label={t.projects.aspectRatio}>
            <Select value={aspectRatio} onChange={setAspectRatio} options={RATIOS.map((v) => ({ value: v, label: t.aspectRatios[v] }))} />
          </Field>
        </div>
        {!file && <p className="text-xs text-neutral-400">{t.projects.uploadHint}</p>}
        {error && <p className="text-xs text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}
