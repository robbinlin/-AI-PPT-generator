import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ProviderInfo } from "@lvs/shared";
import { KeyRound, Trash2 } from "lucide-react";
import { useApi } from "../api/context";
import { errorMessage } from "../api/types";
import { Button } from "../components/ui/Button";
import { inputClass } from "../components/ui/Field";
import { Badge, Spinner } from "../components/ui/Misc";
import { ConfirmHost } from "../components/ConfirmHost";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { fmt, t } from "../i18n";
import { confirmAction } from "../store/confirmStore";

export function ProvidersPage() {
  useDocumentTitle(t.app.navProviders);
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
          p.id === updated.id && p.requiresApiKey
            ? withKeySource({ ...p, configured: updated.configured }, updated.keySource)
            : p,
        ) ?? null,
    );
  };

  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <ConfirmHost />
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
        // Narrow windows (under 1024 px): each provider becomes a card (rows stack, header hidden).
        <table className="block w-full border-separate border-spacing-0 overflow-hidden rounded-lg border border-neutral-800 text-sm lg:table">
          <thead className="hidden bg-neutral-900 text-left text-xs text-neutral-400 lg:table-header-group">
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
          <tbody className="block lg:table-row-group">
            {providers.map((p) => (
              <ProviderRow
                key={`${p.kind}:${p.id}`}
                provider={p}
                sharedWith={providers.filter((o) => o.id === p.id && o.kind !== p.kind).map((o) => t.providers.kinds[o.kind])}
                onUpdated={applyUpdate}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function withKeySource(p: ProviderInfo, keySource: ProviderInfo["keySource"]): ProviderInfo {
  const { keySource: _old, ...rest } = p;
  return keySource ? { ...rest, keySource } : rest;
}

const cell = "block border-neutral-800/70 px-4 py-1.5 lg:table-cell lg:border-b lg:py-3";

function ProviderRow({
  provider,
  sharedWith,
  onUpdated,
}: {
  provider: ProviderInfo;
  /** Other kinds of the same vendor that use this key (Gemini: 寫稿 + 語音). */
  sharedWith: string[];
  onUpdated: (p: ProviderInfo) => void;
}) {
  const api = useApi();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  const run = async (action: () => Promise<ProviderInfo>, okText: string): Promise<boolean> => {
    setBusy(true);
    setMessage(null);
    try {
      onUpdated(await action());
      setMessage({ tone: "ok", text: okText });
      return true;
    } catch (err) {
      setMessage({ tone: "error", text: errorMessage(err) });
      return false;
    } finally {
      setBusy(false);
    }
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    const apiKey = key.trim();
    if (!apiKey) return;
    // Cleared once stored; a rejected key stays so a typo can be fixed instead of pasted again.
    void run(
      () => api.setProviderKey(provider.id, { apiKey }),
      t.providers.saved,
    ).then((ok) => ok && setKey(""));
  };

  const remove = async () => {
    const ok = await confirmAction({
      title: fmt(t.providers.removeConfirm, { name: provider.displayName }),
      lines: [
        fmt(t.providers.removeUses, { uses: [t.providers.kinds[provider.kind], ...sharedWith].join("、") }),
        t.providers.removeAfter,
      ],
      note: t.providers.removeNote,
      confirmLabel: t.common.remove,
      danger: true,
    });
    if (!ok) return;
    void run(() => api.deleteProviderKey(provider.id), t.providers.removed);
  };

  return (
    <tr className="block border-b border-neutral-800 py-2 align-middle last:border-b-0 lg:table-row lg:border-b-0 lg:py-0">
      <td className={cell}>
        <div className="font-medium text-neutral-100">
          {provider.displayName}
        </div>
        {sharedWith.length > 0 && provider.requiresApiKey && (
          <p className="mt-0.5 text-xs text-neutral-400">{fmt(t.providers.keyShared, { kinds: sharedWith.join("、") })}</p>
        )}
      </td>
      <td className={`${cell} text-neutral-300`}>
        <span className="text-neutral-400 lg:hidden">{t.providers.kindLabel}</span>
        {t.providers.kinds[provider.kind]}
      </td>
      <td className={cell}>
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
          <p className="mt-1 max-w-xs text-xs text-neutral-400">
            {provider.hint}
          </p>
        )}
      </td>
      <td className={cell}>
        {provider.requiresApiKey ? (
          <form className="flex w-full max-w-xl flex-col gap-1" onSubmit={save}>
            <div className="flex flex-wrap items-center gap-2">
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
                  onClick={() => void remove()}
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
              <p className="text-xs text-neutral-400">
                {t.providers.platformHint}
              </p>
            )}
          </form>
        ) : (
          <span className="text-xs text-neutral-400">
            {t.providers.noKeyNeeded}
          </span>
        )}
      </td>
    </tr>
  );
}
