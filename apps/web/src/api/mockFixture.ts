import type { GlossaryEntry, ProviderInfo } from "@lvs/shared";
import type { AvatarOption, VoiceOption } from "./types";

/** Static content for the mock API's demo project. */

export interface FixtureSlide {
  title: string;
  bullets: string[];
  notes?: string;
}

export const DEMO_PROJECT_NAME = "示範專案：機器學習導論";
export const DEMO_SOURCE_FILENAME = "ML-week1-intro.pptx";

export const FIXTURE_SLIDES: FixtureSlide[] = [
  { title: "機器學習導論", bullets: ["課程目標", "本週大綱", "評分方式"], notes: "開場，介紹課程定位。" },
  { title: "什麼是機器學習？", bullets: ["從資料中學習規則", "監督式與非監督式", "生活中的例子"] },
  { title: "線性迴歸", bullets: ["模型 y = wx + b", "損失函數 MSE", "梯度下降"] },
  { title: "過擬合與正則化", bullets: ["訓練誤差與測試誤差", "L1 / L2 正則化", "交叉驗證"] },
  { title: "神經網路基礎", bullets: ["感知器", "啟動函數", "反向傳播"] },
  { title: "總結與下週預告", bullets: ["重點回顧", "作業說明", "延伸閱讀"] },
];

/** Hand-written scripts for the first three pages (the rest are "generated" by the running job). */
export const FIXTURE_SCRIPTS: string[] = [
  "各位同學好，歡迎來到機器學習導論。今天我們會先說明這門課的目標，接著快速瀏覽本週的大綱，最後說明評分方式，讓大家對整學期有清楚的期待。",
  "什麼是機器學習？簡單來說，就是讓電腦從資料中自己找出規則，而不是由我們逐條寫好。依照資料有沒有標準答案，可以分成監督式學習與非監督式學習。其實你每天用的推薦系統、垃圾郵件過濾，都是機器學習的例子。",
  "接下來看最基本的模型：線性迴歸。它假設輸出和輸入之間是一條直線，也就是 y = wx + b。我們用 MSE，也就是均方誤差，來衡量預測得好不好，再用梯度下降一步一步調整 w 和 b。這一頁我補充了一個小例子，請大家對照講義。",
];

/** An older (AI) version of page 3, whose audio is what currently exists — hence `stale`. */
export const FIXTURE_PAGE3_V1 =
  "接下來看最基本的模型：線性迴歸。它假設輸出和輸入之間是一條直線，也就是 y = wx + b。我們用 MSE 衡量預測誤差，再用梯度下降調整參數。";

export const FIXTURE_GLOSSARY: GlossaryEntry[] = [
  { term: "MSE", reading: "M S E", definition: "均方誤差 Mean Squared Error" },
  { term: "y = wx + b", reading: "y 等於 w x 加 b", definition: "一元線性模型" },
  { term: "L1 / L2", reading: "L 一、L 二", definition: "兩種常見的正則化項" },
  { term: "梯度下降", reading: "ㄊㄧ ㄉㄨˋ 下降", definition: "沿著損失函數梯度的反方向更新參數" },
];

export const FIXTURE_OBJECTIVES = [
  "說明機器學習與傳統程式設計的差異",
  "能以線性迴歸為例解釋損失函數與梯度下降",
  "辨識過擬合並說出至少兩種緩解方法",
];

export const FIXTURE_SUMMARY =
  "本週從機器學習的定義出發，以線性迴歸串起模型、損失與最佳化三個核心概念，再延伸到過擬合與神經網路，最後預告下週內容。";

export const FIXTURE_SECTIONS: Array<{ title: string; pages: number[]; keyPoints: string[] }> = [
  { title: "課程導入", pages: [1, 2], keyPoints: ["課程目標與評分", "機器學習的定義"] },
  { title: "第一個模型", pages: [3, 4], keyPoints: ["線性迴歸", "損失函數", "過擬合"] },
  { title: "延伸與總結", pages: [5, 6], keyPoints: ["神經網路直覺", "作業與預告"] },
];

export const MOCK_PROVIDERS: ProviderInfo[] = [
  { id: "gemini", kind: "llm", displayName: "Google Gemini", requiresApiKey: true, configured: true },
  { id: "anthropic", kind: "llm", displayName: "Anthropic Claude", requiresApiKey: true, configured: false },
  { id: "gemini", kind: "tts", displayName: "Gemini TTS", requiresApiKey: true, configured: true },
  { id: "elevenlabs", kind: "tts", displayName: "ElevenLabs", requiresApiKey: true, configured: false },
  { id: "heygen", kind: "avatar", displayName: "HeyGen", requiresApiKey: true, configured: false },
  { id: "mock", kind: "avatar", displayName: "Mock avatar (offline)", requiresApiKey: false, configured: true },
];

export const MOCK_VOICES: Record<string, VoiceOption[]> = {
  gemini: [
    // The schema's default voice: the demo project must not find its own voice missing.
    { id: "Orus", name: "Orus（穩重男聲）", languages: ["zh-TW", "en", "mixed"], gender: "male" },
    { id: "Kore", name: "Kore（沉穩女聲）", languages: ["zh-TW", "en", "mixed"], gender: "female" },
    { id: "Puck", name: "Puck（明亮男聲）", languages: ["zh-TW", "en", "mixed"], gender: "male" },
    { id: "Charon", name: "Charon（低沉男聲）", languages: ["zh-TW", "en"], gender: "male" },
    { id: "Aoede", name: "Aoede（輕快女聲）", languages: ["zh-TW", "en"], gender: "female" },
  ],
  elevenlabs: [
    { id: "rachel", name: "Rachel", languages: ["en"], gender: "female" },
    { id: "adam", name: "Adam", languages: ["en"], gender: "male" },
  ],
};

export const MOCK_AVATARS: Record<string, AvatarOption[]> = {
  heygen: [
    { id: "amy-office", name: "Amy · 辦公室", kind: "stock" },
    { id: "daniel-casual", name: "Daniel · 休閒", kind: "stock" },
  ],
  mock: [{ id: "silhouette", name: "剪影", kind: "stock" }],
};

/** Prices used by the mock estimate endpoint (USD). */
export const MOCK_PRICES = {
  ttsPerChar: 0.000016,
  avatarPerSecond: 0.05,
  renderPerSecond: 0,
};

/** Text the mock "LLM" writes for a slide. */
export function mockScriptFor(slide: FixtureSlide, pageNumber: number): string {
  const [a = "重點", b = "細節", c = "例子"] = slide.bullets;
  return `第 ${pageNumber} 頁我們來談「${slide.title}」。首先說明${a}，接著帶大家理解${b}，最後用${c}把概念串起來。`;
}

/** Mock "pronunciation" and "subtitle" derivation: apply glossary readings / trim fillers. */
export function derivePronunciation(script: string, glossary: GlossaryEntry[]): string {
  let out = script;
  for (const g of glossary) if (g.reading) out = out.split(g.term).join(g.reading);
  return out;
}

export function deriveSubtitle(script: string): string {
  return script.replace(/^(那麼|好，|嗯，)/, "").trim();
}
