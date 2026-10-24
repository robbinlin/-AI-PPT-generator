import { t } from "../i18n";

/**
 * Raw job errors come from providers and are often English ("avatar provider and avatarId must
 * be set…"). Common ones get a plain-language explanation; the original stays available as detail.
 * Returns undefined when the message is already readable (our own errors are Chinese).
 */
export function friendlyJobError(message: string | undefined): string | undefined {
  if (!message) return undefined;
  const rules: Array<[RegExp, string]> = [
    [/簡報解析失敗|parse_failed|ConvertError|ParseError|soffice|parser exited/i, t.jobErrors.parse],
    [/avatarId must be set|avatar provider .* must be set|no avatar selected/i, t.jobErrors.noAvatar],
    [/RESOURCE_EXHAUSTED|quota|rate.?limit|\b429\b/i, t.jobErrors.quota],
    [/UNAVAILABLE|overloaded|high demand|\b503\b|\b502\b/i, t.jobErrors.busy],
    [/insufficient|not enough credits|balance|payment required|\b402\b/i, t.jobErrors.credits],
    [/api.?key|unauthori[sz]ed|forbidden|invalid key|\b401\b|\b403\b/i, t.jobErrors.key],
    [/timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network/i, t.jobErrors.network],
    [/refused|safety|content polic|blocked/i, t.jobErrors.refused],
    [/returned (no|an empty)|empty response|no audio|no video_id|no output/i, t.jobErrors.empty],
  ];
  for (const [re, text] of rules) if (re.test(message)) return text;
  // Mostly-English messages without a known cause still get a short Chinese lead-in.
  // The server puts a Chinese label in front (「產生講稿失敗：…：anthropic: …」): judge the vendor's
  // part, after the last 「：」.
  const tail = message.slice(message.lastIndexOf("：") + 1);
  const latin = (tail.match(/[A-Za-z]/g) ?? []).length;
  const cjk = (tail.match(/[㐀-鿿]/g) ?? []).length;
  return latin > 20 && cjk === 0 ? t.jobErrors.generic : undefined;
}
