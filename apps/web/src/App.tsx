import { useEffect, useMemo, useState } from "react";
import { createBrowserRouter, Outlet, RouterProvider } from "react-router";
import { ApiProvider, resolveApiEnv, type ApiEnv } from "./api/context";
import { errorMessage } from "./api/types";
import { MockBanner } from "./components/MockBanner";
import { Toasts } from "./components/Toasts";
import { Spinner } from "./components/ui/Misc";
import { fmt, t } from "./i18n";
import { AppLayout } from "./pages/AppLayout";
import { EditorPage } from "./pages/EditorPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { ProvidersPage } from "./pages/ProvidersPage";

/** Banner, page and toasts around every route. */
function Root() {
  return (
    <>
      <div className="flex h-full flex-col">
        <MockBanner />
        <div className="min-h-0 flex-1">
          <Outlet />
        </div>
      </div>
      <Toasts />
    </>
  );
}

/**
 * A data router (not <BrowserRouter>) so the editor can block navigation — links, the
 * browser's back button — while there are unsaved glossary edits (useBlocker).
 */
function makeRouter() {
  return createBrowserRouter([
    {
      element: <Root />,
      children: [
        { path: "/projects/:projectId", element: <EditorPage /> },
        {
          element: <AppLayout />,
          children: [
            { index: true, element: <ProjectsPage /> },
            { path: "/settings/providers", element: <ProvidersPage /> },
            { path: "*", element: <NotFoundPage /> },
          ],
        },
      ],
    },
  ]);
}

export function App() {
  const [env, setEnv] = useState<ApiEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const router = useMemo(() => (env ? makeRouter() : null), [env]);

  useEffect(() => {
    let alive = true;
    resolveApiEnv()
      .then((e) => alive && setEnv(e))
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) {
    return <div className="p-8 text-sm text-rose-300">{fmt(t.app.error, { message: error })}</div>;
  }
  if (!env || !router) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-400">
        <Spinner /> {t.app.loading}
      </div>
    );
  }

  return (
    <ApiProvider env={env}>
      <RouterProvider router={router} />
    </ApiProvider>
  );
}
