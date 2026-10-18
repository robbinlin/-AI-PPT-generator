import { useEffect, useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
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

export function App() {
  const [env, setEnv] = useState<ApiEnv | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  if (!env) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-neutral-400">
        <Spinner /> {t.app.loading}
      </div>
    );
  }

  return (
    <ApiProvider env={env}>
      <BrowserRouter>
        <div className="flex h-full flex-col">
          <MockBanner />
          <div className="min-h-0 flex-1">
            <Routes>
              <Route path="/projects/:projectId" element={<EditorPage />} />
              <Route element={<AppLayout />}>
                <Route index element={<ProjectsPage />} />
                <Route path="/settings/providers" element={<ProvidersPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
          </div>
        </div>
        <Toasts />
      </BrowserRouter>
    </ApiProvider>
  );
}
