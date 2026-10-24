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

const DEMO_KEY = "lvs:demo-ok";

function readDemoChoice(): boolean {
  try {
    return sessionStorage.getItem(DEMO_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDemoChoice(): void {
  try {
    sessionStorage.setItem(DEMO_KEY, "1");
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
}

export function App() {
  const [env, setEnv] = useState<ApiEnv | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Demo data is never used silently: with the server unreachable the user chooses (once per tab).
  const [demoOk, setDemoOk] = useState(() => readDemoChoice());
  const router = useMemo(() => (env ? makeRouter() : null), [env]);

  useEffect(() => {
    let alive = true;
    setEnv(null);
    resolveApiEnv()
      .then((e) => alive && setEnv(e))
      .catch((err: unknown) => alive && setError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [attempt]);

  if (error) {
    return <div className="p-8 text-sm text-rose-300">{fmt(t.app.error, { message: error })}</div>;
  }
  if (env?.mockReason === "unreachable" && !demoOk) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 p-8">
        <div role="alert" className="max-w-md rounded-xl border border-neutral-800 bg-neutral-900 p-6 text-sm text-neutral-300">
          <h1 className="mb-2 text-base font-semibold text-neutral-100">{t.app.offlineTitle}</h1>
          <p className="mb-4">{fmt(t.app.offlineBody, { url: env.baseUrl })}</p>
          <div className="flex gap-2">
            <button type="button" className="rounded-md bg-accent-600 px-3 py-1.5 text-white hover:bg-accent-500" onClick={() => setAttempt((n) => n + 1)} autoFocus>
              {t.app.retry}
            </button>
            <button
              type="button"
              className="rounded-md border border-neutral-700 px-3 py-1.5 hover:border-neutral-500"
              onClick={() => {
                writeDemoChoice();
                setDemoOk(true);
              }}
            >
              {t.app.useDemo}
            </button>
          </div>
        </div>
      </div>
    );
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
