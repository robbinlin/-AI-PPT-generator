import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ProviderInfo } from "@lvs/shared";
import { KeyRound, Trash2 } from "lucide-react";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { Button } from "../components/ui/Button";
import { inputClass } from "../components/ui/Field";
import { Badge, Spinner } from "../components/ui/Misc";
import { fmt, t } from "../i18n";

export function ProvidersPage() {
  const api = useApi();
  const [providers, setProviders] = useState<ProviderInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listProviders()
      .then(setProviders)
      .catch((err: unknown) => setError(errorMessage(err)));
  }, [api]);
  useEffect(load, [load]);

  /** A key belongs to a provider id, which may appear once per kind (e.g. Gemini LLM + TTS). */
  const applyUpdate = (updated: ProviderInfo) => {
    setProviders(
      (list) =>
        list?.map((p) =>
          p.id === updated.id
            ? { ...p, configured: updated.configured || !p.requiresApiKey }
            : p,
        ) ?? null,
    );
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <h1 className="text-lg font-semibold text-neutral-100">
        {t.providers.title}
      </h1>
      <p className="mt-1 mb-6 text-sm text-neutral-400">
        {t.providers.subtitle}
      </p>
      {error && (
        <p className="mb-4 text-sm text-rose-300">
          {fmt(t.providers.loadFailed, { message: error })}
        </p>
      )}
      {!providers && !error && (
        <div className="flex items-center gap-2 text-sm text-neutral-400">
          <Spinner /> {t.app.loading}
        </div>
      )}
      {providers && providers.length === 0 && (
        <p className="text-sm text-neutral-400">{t.providers.empty}</p>
      )}
      {providers && providers.length > 0 && (
        <table className="w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-neutral-800 text-sm">
          <thead className="bg-neutral-900 text-left text-xs text-neutral-400">
            <tr>
              <th className="border-b border-neutral-800 px-4 py-2 font-medium">
                {t.providers.name}
              </th>
              <th className="border-b border-neutral-800 px-4 py-2 font-medium">
                {t.providers.kind}
              </th>
              <th className="border-b border-neutral-800 px-4 py-2 font-medium">
                {t.providers.status}
              </th>
              <th className="border-b border-neutral-800 px-4 py-2 font-medium">
                {t.providers.key}
              </th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <ProviderRow
                key={`${p.kind}:${p.id}`}
                provider={p}
                onUpdated={applyUpdate}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ProviderRow({
  provider,
  onUpdated,
}: {
  provider: ProviderInfo;
  onUpdated: (p: ProviderInfo) => void;
}) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const run = async (action: () => Promise<ProviderInfo>, okText: string) => {
    setBusy(true);
    setMessage(null);
    try {
      onUpdated(await action());
      setMessage({ tone: "ok", text: okText });
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const apiKey = key.trim();
    if (!apiKey) return;
    // Clear immediately: the key never lingers in component state after submit.
    setKey("");
    void run(
      () => api.setProviderKey(provider.id, { apiKey }),
      t.providers.saved,
    );
  };

  const remove = () => {
    if (
      !window.confirm(
        fmt(t.providers.removeConfirm, { name: provider.displayName }),
      )
    )
      return;
    void run(() => api.deleteProviderKey(provider.id), t.providers.removed);
  };

  return (
    <tr className="align-middle">
      <td className="border-b border-neutral-800/70 px-4 py-3">
        <div className="font-medium text-neutral-100">
          {provider.displayName}
        </div>
        <div className="font-mono text-xs text-neutral-500">{provider.id}</div>
      </td>
      <td className="border-b border-neutral-800/70 px-4 py-3 text-neutral-300">
        {t.providers.kinds[provider.kind]}
      </td>
      <td className="border-b border-neutral-800/70 px-4 py-3">
        {provider.configured ? (
          <Badge tone="success">
            {provider.keySource === "platform"
              ? t.providers.configuredPlatform
              : t.providers.configured}
          </Badge>
        ) : (
          <Badge tone="warning">{t.providers.notConfigured}</Badge>
        )}
        {provider.hint && (
          <p className="mt-1 max-w-xs text-xs text-neutral-500">
            {provider.hint}
          </p>
        )}
      </td>
      <td className="border-b border-neutral-800/70 px-4 py-3">
        {provider.requiresApiKey ? (
          <form className="flex w-full max-w-xl flex-col gap-1" onSubmit={save}>
            <div className="flex items-center gap-2">
              <input
                type="password"
                // "new-password" stops browser password managers from filling a saved value back in
                // (they ignore autocomplete="off" on password fields).
                autoComplete="new-password"
                data-lpignore="true"
                data-1p-ignore
                spellCheck={false}
                aria-label={`${provider.displayName} ${t.providers.key}`}
                placeholder={t.providers.keyPlaceholder}
                value={key}
                maxLength={500}
                onChange={(e) => setKey(e.target.value)}
                className={`${inputClass} min-w-0 flex-1`}
              />
              <Button
                type="submit"
                size="sm"
                icon={KeyRound}
                disabled={busy || !key.trim()}
              >
                {t.common.save}
              </Button>
              {provider.keySource === "user" && (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash2}
                  disabled={busy}
                  onClick={remove}
                >
                  {t.common.remove}
                </Button>
              )}
              {message && (
                <span
                  className={`text-xs ${message.tone === "ok" ? "text-emerald-400" : "text-rose-300"}`}
                >
                  {message.text}
                </span>
              )}
            </div>
            {provider.keySource === "platform" && (
              <p className="text-xs text-neutral-500">
                {t.providers.platformHint}
              </p>
            )}
          </form>
        ) : (
          <span className="text-xs text-neutral-500">
            {t.providers.noKeyNeeded}
          </span>
        )}
      </td>
    </tr>
  );
}
