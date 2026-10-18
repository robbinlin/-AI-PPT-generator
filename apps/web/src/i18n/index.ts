import { zhTW, type Strings } from "./zh-TW";

/** Active string table. The locale switch (zh-TW / en) will replace this binding. */
export const t: Strings = zhTW;

/** Replaces `{key}` placeholders with values. Unknown keys are left untouched. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : String(value);
  });
}
