import { t } from "../i18n";

/**
 * Raw job errors come from providers and are often English ("avatar provider and avatarId must
 * be set…"). Common ones get a plain-language explanation; the original stays available as detail.
 * Returns undefined when the message is already readable (our own errors are Chinese).
 */
export function friendlyJobError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const rules: Array<[RegExp, string]> = [
    [/avatarId must be set|avatar provider .* must be set|no avatar selected/i, t.jobErrors.noAvatar],
    [/RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b/i, t.jobErrors.quota],
    [/UNAVAILABLE|overloaded|high demand|\b503\b|\b502\b/i, t.jobErrors.busy],
    [/insufficient|not enough credits|balance|payment required|\b402\b/i, t.jobErrors.credits],
    [/api.?key|unauthori[sz]ed|forbidden|invalid key|\b401\b|\b403\b/i, t.jobErrors.key],
    [/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network/i, t.jobErrors.network],
  ];
  for (const [re, text] of rules) if (re.test(message)) return text;
  // Mostly-English messages without a known cause still get a short Chinese lead-in.
  const latin = (message.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (message.match(/[㐀-鿿]/g) ?? []).length;
  return latin > 20 && cjk === 0 ? t.jobErrors.generic : undefined;
}
