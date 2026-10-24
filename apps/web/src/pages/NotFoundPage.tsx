import { Link } from "react-router";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { t } from "../i18n";

export function NotFoundPage() {
  useDocumentTitle(t.app.notFound);
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <h1 className="text-base font-medium text-neutral-200">{t.app.notFound}</h1>
      <Link to="/" className="mt-4 inline-flex items-center rounded-md bg-accent-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-500">
        {t.app.backToProjects}
      </Link>
    </div>
  );
}
