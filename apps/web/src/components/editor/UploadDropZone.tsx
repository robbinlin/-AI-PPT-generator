import { useRef, useState, type DragEvent } from "react";
import { FileUp } from "lucide-react";
import { ACCEPTED_EXTENSIONS } from "../../hooks/useEditorActions";
import { fmt, t } from "../../i18n";
import { useEditor } from "../../store/editorStore";
import { Button } from "../ui/Button";
import { ProgressBar } from "../ui/Misc";

export interface UploadDropZoneProps {
  onFile: (file: File) => void;
}

/** Empty-state drop zone: drag a PPTX/PPT/PDF in, or pick one. */
export function UploadDropZone({ onFile }: UploadDropZoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const upload = useEditor((s) => s.upload);
  const uploading = upload.progress !== null;

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file && !uploading) onFile(file);
  };

  return (
    <div
      data-testid="upload-dropzone"
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={`flex w-full max-w-xl flex-col items-center gap-4 rounded-xl border-2 border-dashed px-8 py-14 text-center transition-colors ${
        over ? "border-accent-400 bg-accent-500/10" : "border-neutral-700 bg-neutral-900/60"
      }`}
    >
      <FileUp className="size-10 text-neutral-400" aria-hidden />
      <div>
        <h2 className="text-base font-semibold text-neutral-100">{t.upload.title}</h2>
        <p className="mt-1 text-sm text-neutral-400">{t.upload.body}</p>
      </div>
      {uploading ? (
        <div className="w-64">
          <ProgressBar value={upload.progress ?? 0} />
          <p className="mt-2 text-xs text-neutral-400">
            {fmt(t.upload.uploading, { pct: Math.round((upload.progress ?? 0) * 100) })}
          </p>
        </div>
      ) : (
        <Button variant="primary" onClick={() => input.current?.click()}>
          {t.upload.choose}
        </Button>
      )}
      {upload.error && <p className="text-sm text-rose-300">{upload.error}</p>}
      <input
        ref={input}
        type="file"
        hidden
        accept={ACCEPTED_EXTENSIONS.join(",")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

export interface ParseProgressProps {
  filename: string;
  progress: number | undefined;
  message: string | undefined;
  failed: string | null;
}

export function ParseProgress({ filename, progress, message, failed }: ParseProgressProps) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-neutral-800 bg-neutral-900/60 px-8 py-12 text-center">
      <p className="text-sm font-medium text-neutral-100">{filename}</p>
      {failed ? (
        <p className="text-sm text-rose-300">{fmt(t.upload.parseFailed, { message: failed })}</p>
      ) : (
        <>
          <div className="w-64">
            <ProgressBar value={progress ?? 0} indeterminate={progress === undefined || progress === 0} />
          </div>
          <p className="text-xs text-neutral-400">
            {progress ? fmt(t.upload.parsing, { pct: Math.round(progress * 100) }) : t.upload.parsingDefault}
            {message ? `・${message}` : ""}
          </p>
        </>
      )}
    </div>
  );
}
