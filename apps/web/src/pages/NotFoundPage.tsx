import { Link } from "react-router";
import { t } from "../i18n";

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md py-24 text-center">
      <p className="text-neutral-300">{t.app.notFound}</p>
      <Link to="/" className="mt-3 inline-block text-sm text-accent-400 hover:underline">
        {t.app.backToProjects}
      </Link>
    </div>
  );
}
