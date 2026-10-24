import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { Copy, FileStack, FileUp, Languages, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useApi, useAssetUrl } from "../api/context";
import { errorMessage, type ProjectSummary } from "../api/types";
import { ConfirmHost } from "../components/ConfirmHost";
import { NewProjectDialog } from "../components/projects/NewProjectDialog";
import { Button, IconButton } from "../components/ui/Button";
import { Field, TextInput } from "../components/ui/Field";
import { Spinner } from "../components/ui/Misc";
import { Modal } from "../components/ui/Modal";
import { fmt, t } from "../i18n";
import { targetLanguageName, useTranslateProject } from "../hooks/useTranslateProject";
import { formatRelativeTime } from "../lib/format";
import { setPendingUpload } from "../lib/pendingUpload";
import { toast } from "../store/toastStore";

type PendingAction = { kind: "rename" | "delete"; project: ProjectSummary };

export function ProjectsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [pageDragging, setPageDragging] = useState(false);
  const translate = useTranslateProject();

  const load = useCallback(() => {
    setError(null);
    api
      .listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [api]);

  useEffect(load, [load]);

  const rename = async (project: ProjectSummary, name: string) => {
    const updated = await api.updateProject(project.id, { name });
    setProjects((list) => list?.map((p) => (p.id === project.id ? { ...p, name: updated.name, updatedAt: updated.updatedAt } : p)) ?? null);
  };
  // Reuse last week's setup (voice, avatar, layout, subtitles) for a new deck.
  const duplicate = async (project: ProjectSummary) => {
    try {
      const created = await api.createProject({ name: fmt(t.projects.copyName, { name: project.name }).slice(0, 200), settings: project.settings });
      toast(t.projects.duplicated, "success");
      navigate(`/projects/${created.id}`);
    } catch (err) {
      toast(errorMessage(err), "error");
    }
  };
  const remove = async (project: ProjectSummary) => {
    await api.deleteProject(project.id);
    setProjects((list) => list?.filter((p) => p.id !== project.id) ?? null);
  };

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-neutral-100">{t.projects.title}</h1>
        <Button variant="primary" icon={Plus} onClick={() => setDialogOpen(true)}>
          {t.projects.newProject}
        </Button>
      </div>

      {error && (
        <p className="mb-4 text-sm text-rose-300">
          {fmt(t.app.error, { message: error })}{" "}
          <button type="button" className="underline" onClick={load}>
            {t.app.retry}
          </button>
        </p>
      )}
      {!projects && !error && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Spinner /> {t.app.loading}
        </div>
      )}
      <button
        type="button"
        className={`mb-6 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-sm transition-colors ${
          pageDragging ? "border-accent-400 bg-accent-500/10 text-accent-100" : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
        }`}
        onClick={() => setDialogOpen(true)}
        onDragOver={(e) => {
          e.preventDefault();
          setPageDragging(true);
        }}
        onDragLeave={() => setPageDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setPageDragging(false);
          const file = e.dataTransfer.files[0];
          if (!file) return;
          setDroppedFile(file);
          setDialogOpen(true);
        }}
        data-testid="projects-drop"
      >
        <FileUp className="size-5" aria-hidden />
        {pageDragging ? t.projects.pageDropActive : t.projects.pageDrop}
      </button>
      {projects?.length === 0 && <p className="text-sm text-neutral-400">{t.projects.empty}</p>}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        {projects?.map((p) => (
          <li key={p.id}>
            <ProjectCard
              project={p}
              onRename={() => setPending({ kind: "rename", project: p })}
              onDuplicate={() => void duplicate(p)}
              onTranslate={p.pageCount ? () => void translate(p) : undefined}
              onDelete={() => setPending({ kind: "delete", project: p })}
            />
          </li>
        ))}
      </ul>

      <NewProjectDialog
        open={dialogOpen}
        initialFile={droppedFile}
        onClose={() => {
          setDialogOpen(false);
          setDroppedFile(null);
        }}
        onCreate={async (req, file) => {
          const project = await api.createProject(req);
          // The editor uploads it on open, with the usual progress and parse status.
          if (file) setPendingUpload(project.id, file);
          setDialogOpen(false);
          setDroppedFile(null);
          navigate(`/projects/${project.id}`);
        }}
      />
      <RenameDialog
        project={pending?.kind === "rename" ? pending.project : null}
        onClose={() => setPending(null)}
        onSubmit={async (name) => {
          if (pending) await rename(pending.project, name);
          setPending(null);
        }}
      />
      <DeleteDialog
        project={pending?.kind === "delete" ? pending.project : null}
        onClose={() => setPending(null)}
        onConfirm={async () => {
          if (pending) await remove(pending.project);
          setPending(null);
          toast(t.projects.deleted);
        }}
      />
      <ConfirmHost />
    </div>
  );
}

function ProjectCard({
  project,
  onRename,
  onDuplicate,
  onTranslate,
  onDelete,
}: {
  project: ProjectSummary;
  onRename: () => void;
  onDuplicate: () => void;
  /** Absent until the project has slides. */
  onTranslate?: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const thumbUrl = useAssetUrl(project.id, project.thumbnailAssetId);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const pick = (fn: () => void) => () => {
    setMenuOpen(false);
    fn();
  };

  return (
    <div className="group relative h-full">
      <Link
        to={`/projects/${project.id}`}
        className="flex h-full flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 transition-colors hover:border-neutral-600"
      >
        <div className="flex aspect-video items-center justify-center overflow-hidden rounded-md bg-neutral-800/60">
          {thumbUrl ? (
            <img src={thumbUrl} alt="" className="size-full object-contain" loading="lazy" draggable={false} />
          ) : (
            <FileStack className="size-8 text-neutral-600" aria-hidden />
          )}
        </div>
        <div className="min-w-0 pr-8">
          <h2 className="truncate text-sm font-semibold text-neutral-100">{project.name}</h2>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs whitespace-nowrap text-neutral-400">
            <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-xs font-medium text-neutral-300" data-testid="language-badge">
              {t.projects.languageBadge[project.settings.language]}
            </span>
            <span>
              {project.pageCount === undefined
                ? t.projects.pagesUnknown
                : project.activePageCount !== undefined && project.activePageCount < project.pageCount
                  ? fmt(t.projects.activePages, { n: project.pageCount, active: project.activePageCount })
                  : fmt(t.projects.pages, { n: project.pageCount })}
            </span>
            <span>
              <span aria-hidden>· </span>
              {fmt(t.projects.updated, { time: formatRelativeTime(project.updatedAt) })}
            </span>
          </p>
        </div>
      </Link>
      <div ref={menuRef} className="absolute right-3 bottom-3">
        <IconButton
          icon={MoreHorizontal}
          label={t.projects.menu}
          active={menuOpen}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="bg-neutral-900/80"
          onClick={() => setMenuOpen((v) => !v)}
        />
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 bottom-9 z-20 w-52 overflow-hidden rounded-md border border-neutral-700 bg-neutral-800 py-1 shadow-xl"
          >
            <MenuItem icon={Pencil} label={t.projects.rename} onClick={pick(onRename)} />
            <MenuItem icon={Copy} label={t.projects.duplicate} onClick={pick(onDuplicate)} />
            {onTranslate && project.settings.language !== "mixed" && (
              <MenuItem icon={Languages} label={fmt(t.projects.translate, { lang: targetLanguageName(project.settings.language) })} onClick={pick(onTranslate)} />
            )}
            <MenuItem icon={Trash2} label={t.projects.delete} onClick={pick(onDelete)} danger />
          </div>
        )}
      </div>
    </div>
  );
}

function MenuItem({ icon: Icon, label, onClick, danger = false }: { icon: typeof Pencil; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-neutral-700 ${
        danger ? "text-rose-300" : "text-neutral-100"
      }`}
    >
      <Icon className="size-4" aria-hidden />
      {label}
    </button>
  );
}

function RenameDialog({ project, onClose, onSubmit }: { project: ProjectSummary | null; onClose: () => void; onSubmit: (name: string) => Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(project?.name ?? "");
    setError(null);
  }, [project]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t.projects.renameTitle}
      open={project !== null}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button variant="primary" form="rename-project-form" type="submit" disabled={busy || !name.trim()}>
            {busy ? t.script.saving : t.common.save}
          </Button>
        </>
      }
    >
      <form id="rename-project-form" onSubmit={submit} className="flex flex-col gap-3">
        <Field label={t.projects.name}>
          <TextInput value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        {error && <p className="text-xs text-rose-300">{error}</p>}
      </form>
    </Modal>
  );
}

function DeleteDialog({ project, onClose, onConfirm }: { project: ProjectSummary | null; onClose: () => void; onConfirm: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [project]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={t.projects.deleteTitle}
      open={project !== null}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" data-autofocus onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy}>
            {busy ? t.projects.deleting : t.projects.delete}
          </Button>
        </>
      }
    >
      <p className="text-sm text-neutral-300">{fmt(t.projects.deleteConfirm, { name: project?.name ?? "" })}</p>
      {error && <p className="mt-2 text-xs text-rose-300">{error}</p>}
    </Modal>
  );
}
