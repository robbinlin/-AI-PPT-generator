import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { FileStack, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useApi } from "../api/context";
import { errorMessage, type ProjectSummary } from "../api/types";
import { NewProjectDialog } from "../components/projects/NewProjectDialog";
import { Button, IconButton } from "../components/ui/Button";
import { Field, TextInput } from "../components/ui/Field";
import { Spinner } from "../components/ui/Misc";
import { Modal } from "../components/ui/Modal";
import { fmt, t } from "../i18n";
import { formatRelativeTime } from "../lib/format";
import { toast } from "../store/toastStore";

type PendingAction = { kind: "rename" | "delete"; project: ProjectSummary };

export function ProjectsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);

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
      {projects?.length === 0 && <p className="text-sm text-neutral-400">{t.projects.empty}</p>}

      <ul className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        {projects?.map((p) => (
          <li key={p.id}>
            <ProjectCard
              project={p}
              onRename={() => setPending({ kind: "rename", project: p })}
              onDelete={() => setPending({ kind: "delete", project: p })}
            />
          </li>
        ))}
      </ul>

      <NewProjectDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreate={async (req) => {
          const project = await api.createProject(req);
          setDialogOpen(false);
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
    </div>
  );
}

function ProjectCard({ project, onRename, onDelete }: { project: ProjectSummary; onRename: () => void; onDelete: () => void }) {
  const [menuOpen, setMenuOpen] = useState(false);
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
        <div className="flex aspect-video items-center justify-center rounded-md bg-neutral-800/60">
          <FileStack className="size-8 text-neutral-600" aria-hidden />
        </div>
        <div className="min-w-0 pr-8">
          <h2 className="truncate text-sm font-semibold text-neutral-100">{project.name}</h2>
          <p className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
            <span>
              {project.pageCount !== undefined ? fmt(t.projects.pages, { n: project.pageCount }) : t.projects.pagesUnknown}
            </span>
            <span aria-hidden>·</span>
            <span>{fmt(t.projects.updated, { time: formatRelativeTime(project.updatedAt) })}</span>
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
            className="absolute right-0 bottom-9 z-20 w-40 overflow-hidden rounded-md border border-neutral-700 bg-neutral-800 py-1 shadow-xl"
          >
            <MenuItem icon={Pencil} label={t.projects.rename} onClick={pick(onRename)} />
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
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.common.cancel}
          </Button>
          <Button variant="danger" data-autofocus onClick={() => void confirm()} disabled={busy}>
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
