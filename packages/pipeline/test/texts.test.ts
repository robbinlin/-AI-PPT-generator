import { describe, expect, it } from "vitest";
import {
  applyGlossaryReadings,
  isTranslationNotReading,
  decimalToChinese,
  delatex,
  derivePronunciationText,
  deriveSubtitleText,
  estimateSpeakingSeconds,
  integerToChinese,
  muReading,
  normaliseScripts,
  targetLength,
} from "../src/texts.js";

describe("chinese numerals", () => {
  it("integers", () => {
    expect(integerToChinese(0)).toBe("零");
    expect(integerToChinese(5)).toBe("五");
    expect(integerToChinese(10)).toBe("十");
    expect(integerToChinese(15)).toBe("十五");
    expect(integerToChinese(25)).toBe("二十五");
    expect(integerToChinese(110)).toBe("一百一十");
    expect(integerToChinese(105)).toBe("一百零五");
    expect(integerToChinese(1000)).toBe("一千");
    expect(integerToChinese(10015)).toBe("一萬零一十五");
    expect(integerToChinese(10500)).toBe("一萬零五百");
    expect(integerToChinese(120000)).toBe("十二萬");
    expect(integerToChinese(100000005)).toBe("一億零五");
  });
  it("decimals", () => {
    expect(decimalToChinese("0.05")).toBe("零點零五");
    expect(decimalToChinese("12.5")).toBe("十二點五");
    expect(decimalToChinese("3")).toBe("三");
  });
});

describe("derivePronunciationText (zh-TW)", () => {
  const glossary = [
    { term: "VO₂max", reading: "V O two max" },
    { term: "ANOVA", reading: "變異數分析" },
    { term: "Smith", reading: "史密斯" },
    { term: "CI", reading: "信賴區間" },
  ];
  it("expands glossary readings, longest term first and whole-word for Latin", () => {
    expect(applyGlossaryReadings("ANOVA 與 VO₂max", glossary)).toBe("變異數分析 與 V O two max");
    // "CI" must not match inside "SCIENCE"
    expect(applyGlossaryReadings("SCIENCE CI", glossary)).toBe("SCIENCE 信賴區間");
  });
  it("speaks p-values and comparisons", () => {
    expect(derivePronunciationText("結果 p < .05。", glossary, "zh-TW")).toBe("結果 p 小於 零點零五。");
    expect(derivePronunciationText("差異 p = 0.03，η² ≥ 0.14", glossary, "zh-TW")).toBe("差異 p 等於 零點零三，eta 平方 大於等於 零點一四");
  });
  it("speaks percentages and keeps integers as digits", () => {
    expect(derivePronunciationText("提升 25%，共 120 人", glossary, "zh-TW")).toBe("提升 百分之二十五，共 120 人");
    expect(derivePronunciationText("12.5% 的受試者", glossary, "zh-TW")).toBe("百分之十二點五 的受試者");
  });
  it("normalises subscripts when no reading exists", () => {
    expect(normaliseScripts("H₂O x²")).toBe("H2O x2");
    expect(derivePronunciationText("H₂O", [], "zh-TW")).toBe("H2O");
  });
  it("symbols and greek", () => {
    expect(derivePronunciationText("α = .05 ± 2", glossary, "zh-TW")).toBe("阿爾法 等於 零點零五 正負 2");
    expect(derivePronunciationText("由 A → B", glossary, "zh-TW")).toBe("由 A 到 B");
  });
  it("says μ the lecturer's way (miu): Mew, Mew 0, Mew one", () => {
    expect(derivePronunciationText("H0：μ₀ = μ₁，μ2 > μ", [], "zh-TW")).toBe("H0：Mew 0 等於 Mew one，Mew two 大於 Mew");
    expect(derivePronunciationText("μ存活 減去 μ死亡，μ_diff 等於 0", [], "zh-TW")).toBe("Mew 存活 減去 Mew 死亡，Mew diff 等於 0");
    expect(muReading("μ₀")).toBe("Mew 0");
    expect(muReading("μ1")).toBe("Mew one");
    expect(muReading("μ_diff")).toBe("Mew diff");
    expect(muReading("μ")).toBe("");
    // A bare-μ glossary entry must not turn μ_diff into "Mew_diff" before the rules run.
    expect(derivePronunciationText("μ_diff 與 μ₁", [{ term: "μ", reading: "" }], "zh-TW")).toBe("Mew diff 與 Mew one")
    // Levene is respelled the way it is said (le-VEEN), also after a glossary reading.
    expect(derivePronunciationText("Levene's Test 與 Levene 檢定", [{ term: "Levene's Test", reading: "Levene's 檢定" }], "zh-TW")).toBe("Leveen's 檢定 與 Leveen 檢定");;
    expect(muReading("Levene's Test")).toBeUndefined();
  });
  it("leaves author names to the glossary", () => {
    expect(derivePronunciationText("Smith 等人提出", glossary, "zh-TW")).toBe("史密斯 等人提出");
  });
});

describe("delatex", () => {
  it("turns $…$ math into plain text and leaves the rest alone", () => {
    expect(delatex("我們來看 $R \\times C$ 列聯表，令 $N_{ij}$ 為第 $i$ 列，$R_1$ 到 $R_r$")).toBe("我們來看 R × C 列聯表，令 Nij 為第 i 列，R1 到 Rr");
    expect(delatex("$\\chi^2 \\geq \\frac{a}{b}$，μ_diff 不動")).toBe("χ² ≥ a/b，μ_diff 不動");
    expect(delatex("沒有公式")).toBe("沒有公式");
  });
});

describe("derivePronunciationText (en)", () => {
  it("speaks decimals, percent and comparisons in English", () => {
    expect(derivePronunciationText("p < .05 and 25% of VO₂max", [{ term: "VO₂max", reading: "V O two max" }], "en")).toBe(
      "p less than zero point 0 5 and 25 percent of V O two max",
    );
  });
  it("says chi-square /kaɪ/ and Ha as the letters H A", () => {
    expect(derivePronunciationText("The Chi-Square test and chi squared statistic, χ² with H0 against Ha.", [], "en")).toBe(
      "The kai-Square test and kai squared statistic, kai-square with H0 against H A.",
    );
    expect(derivePronunciationText("對立假設Ha為有關，H_a 也是；Hawaii 與 Hall 不動", [], "zh-TW")).toBe("對立假設H A為有關，H A 也是；Hawaii 與 Hall 不動");
  });
});

describe("deriveSubtitleText", () => {
  it("normalises whitespace only", () => {
    expect(deriveSubtitleText("  第一句。\r\n\r\n  補充：第二句  。 ")).toBe("第一句。\n補充：第二句 。");
    expect(deriveSubtitleText("VO₂max p < .05")).toBe("VO₂max p < .05");
  });
});

describe("length helpers", () => {
  it("estimates speaking seconds", () => {
    expect(estimateSpeakingSeconds("一".repeat(45), "zh-TW")).toBe(10);
    expect(estimateSpeakingSeconds("word ".repeat(25).trim(), "en")).toBe(10);
  });
  it("targetLength", () => {
    expect(targetLength(60, "zh-TW")).toEqual({ chars: 270 });
    expect(targetLength(60, "en")).toEqual({ words: 150 });
  });
});

describe("isTranslationNotReading", () => {
  it("keeps plain English words instead of swapping in a Chinese translation", () => {
    expect(isTranslationNotReading("mean", "平均數")).toBe(true);
    expect(isTranslationNotReading("standard deviation", "標準差")).toBe(true);
    expect(isTranslationNotReading("ANOVA", "變異數分析")).toBe(false); // acronym: speak the Chinese name
    expect(isTranslationNotReading("VO₂max", "V O two max")).toBe(false);
    expect(isTranslationNotReading("mean", "ㄇㄧㄣ")).toBe(false);
    const glossary = [{ term: "mean", reading: "平均數", definition: "" }];
    expect(applyGlossaryReadings("平均數，也就是 mean", glossary)).toBe("平均數，也就是 mean");
  });
});
