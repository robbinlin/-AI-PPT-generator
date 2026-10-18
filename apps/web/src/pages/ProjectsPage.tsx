import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { FileStack, Plus } from "lucide-react";
import { useApi } from "../api/context";
import { errorMessage, type ProjectSummary } from "../api/types";
import { NewProjectDialog } from "../components/projects/NewProjectDialog";
import { Button } from "../components/ui/Button";
import { Spinner } from "../components/ui/Misc";
import { fmt, t } from "../i18n";
import { formatRelativeTime } from "../lib/format";

export function ProjectsPage() {
  const api = useApi();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const load = useCallback(() => {
    setError(null);
    api
      .listProjects()
      .then(setProjects)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [api]);

  useEffect(load, [load]);

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
            <ProjectCard project={p} />
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
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="flex h-full flex-col gap-3 rounded-lg border border-neutral-800 bg-neutral-900 p-4 transition-colors hover:border-neutral-600"
    >
      <div className="flex aspect-video items-center justify-center rounded-md bg-neutral-800/60">
        <FileStack className="size-8 text-neutral-600" aria-hidden />
      </div>
      <div className="min-w-0">
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
  );
}
