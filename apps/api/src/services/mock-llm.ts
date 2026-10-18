/**
 * Prompt-aware responder for the `mock` LLM provider. It reads the slide blocks the
 * pipeline renders into its prompts and answers with plausible, deterministic JSON so the
 * whole flow (outline → scripts → speech → render) runs offline for demos and tests.
 */
import type { MockLlmResponder } from "@lvs/providers";

const SLIDE_HEADER = /^### Slide (\d+) \(page \d+\)$/gm;
const TITLE_LINE = /^Title: (.+)$/m;

function slideBlocks(prompt: string): Array<{ number: number; title: string; body: string }> {
  const out: Array<{ number: number; title: string; body: string }> = [];
  const matches = [...prompt.matchAll(SLIDE_HEADER)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? prompt.length) : prompt.length;
    const block = prompt.slice(start, end);
    const title = TITLE_LINE.exec(block)?.[1]?.trim() ?? `Slide ${m[1]}`;
    const body = block
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("Title:") && !l.startsWith("##") && !l.startsWith("Speaker notes:"))
      .map((l) => l.replace(/^- /, ""))
      .slice(0, 6)
      .join(" ");
    out.push({ number: Number(m[1]), title, body });
  }
  return out;
}

const isOutlinePrompt = (prompt: string) => /^## (投影片內容|Slide content)$/m.test(prompt);

export const smartMockResponder: MockLlmResponder = ({ prompt }) => {
  const zh = /繁體中文|投影片/.test(prompt);
  if (isOutlinePrompt(prompt)) {
    const slides = slideBlocks(prompt);
    const mid = Math.max(1, Math.ceil(slides.length / 2));
    const target = /(\d+) 秒|exactly (\d+)/.exec(prompt);
    const total = target ? Number(target[1] ?? target[2]) : undefined;
    const per = total ? total / Math.max(1, slides.length) : 20;
    return {
      objectives: zh ? ["理解本單元的核心概念", "能解讀圖表與統計結果", "能說明結論的實務意義"] : ["Understand the core concepts", "Interpret the figures and statistics", "Explain the practical implications"],
      summary: zh
        ? `本教材共 ${slides.length} 頁，從「${slides[0]?.title ?? ""}」開始，逐步說明方法、結果與結論。`
        : `This deck has ${slides.length} slides, starting from "${slides[0]?.title ?? ""}" and moving through methods, results and conclusions.`,
      sections: [
        { title: zh ? "前半：背景與方法" : "Part 1: background and methods", slideNumbers: slides.slice(0, mid).map((s) => s.number), keyPoints: slides.slice(0, mid).map((s) => s.title) },
        { title: zh ? "後半：結果與結論" : "Part 2: results and conclusions", slideNumbers: slides.slice(mid).map((s) => s.number), keyPoints: slides.slice(mid).map((s) => s.title) },
      ].filter((s) => s.slideNumbers.length > 0),
      glossary: [
        { term: "VO₂max", reading: "V O two max", definition: zh ? "最大攝氧量" : "maximal oxygen uptake" },
        { term: "ANOVA", reading: zh ? "變異數分析" : "analysis of variance", definition: zh ? "比較多組平均數的統計方法" : "a test comparing several group means" },
        { term: "HIIT", reading: zh ? "高強度間歇訓練" : "high intensity interval training", definition: "" },
      ],
      timeAllocation: slides.map((s) => ({ slideNumber: s.number, seconds: Math.round(per) })),
    };
  }
  // Per-slide script prompt: the current slide is the last "### Slide" block.
  const slides = slideBlocks(prompt);
  const current = slides.at(-1);
  const first = /第一頁：可以|first slide: open/.test(prompt);
  const last = /最後一頁：以|last slide: close/.test(prompt);
  const title = current?.title ?? (zh ? "本頁" : "this slide");
  const body = current?.body ?? "";
  const script = zh
    ? `${first ? "各位同學好，今天我們來看這個主題。" : "接著，"}這一頁的重點是「${title}」。${body ? `內容包括：${body}。` : ""}${last ? "以上就是本單元的全部內容，謝謝大家。" : "我們繼續看下一頁。"}`
    : `${first ? "Hello everyone, today we look at this topic. " : "Next, "}this slide is about "${title}". ${body ? `It covers: ${body}. ` : ""}${last ? "That concludes this unit, thank you." : "Let's move on."}`;
  return { script, pronunciationText: script, subtitleText: script, estimatedDurationSec: Math.max(3, Math.round(script.length / (zh ? 4.5 : 14))) };
};
