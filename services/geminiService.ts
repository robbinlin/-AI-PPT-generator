import { GoogleGenAI, Type, Modality } from "@google/genai";
import type { SlideScript } from '../types';

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  throw new Error("API 金鑰未設定。");
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

export const generateScriptsFromPPT = async (fileContentBase64: string, mimeType: string): Promise<SlideScript[]> => {
  const prompt = `
    你是一位充滿活力、善於互動的演講專家。我已經上傳了一份 PDF 檔案，請你為這份文件的每一頁內容生成一份詳細講稿。

    1.  **分析內容**：深入理解每一頁的核心資訊與視覺元素。
    2.  **生成講稿**：為每一頁撰寫一份獨立的講稿。
    3.  **維持風格**：
        *   **語氣活潑**：使用生動、有能量的語言，避免平鋪直敘。
        *   **互動性強**：在講稿中設計提問、小調查或引導聽眾思考的環節，增強參與感。
    4.  **確保一致**：講稿內容必須與對應的頁面內容高度相關。

    請以繁體中文回答。你的輸出必須是嚴格的 JSON 格式，一個包含多個物件的陣列。每個物件都應包含 "title" (該頁面的標題) 和 "script" (詳細講稿) 兩個鍵。
  `;
  
  const filePart = {
    inlineData: {
      data: fileContentBase64,
      mimeType: mimeType,
    },
  };

  const textPart = {
    text: prompt,
  };

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-pro",
      contents: { parts: [textPart, filePart] },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              title: {
                type: Type.STRING,
                description: "這一頁 PDF 的標題或核心概念",
              },
              script: {
                type: Type.STRING,
                description: "這一頁 PDF 的詳細、活潑且具互動性的講稿內容",
              },
            },
            required: ["title", "script"],
          },
        },
      },
    });

    const jsonText = response.text.trim();
    const scripts = JSON.parse(jsonText);
    
    if (Array.isArray(scripts) && scripts.every(s => 'title' in s && 'script' in s)) {
      return scripts as SlideScript[];
    } else {
      throw new Error("從 API 收到的資料格式不正確。");
    }

  } catch (error) {
    console.error("呼叫 Gemini API 時發生錯誤:", error);
    let errorMessage = "生成講稿失敗，請稍後再試。";
    if (error instanceof Error && error.message.includes('json')) {
      errorMessage = "AI 回應的格式有誤，無法解析講稿。請稍後重試或更換檔案。"
    } else if (error instanceof Error) {
        errorMessage = `生成講稿失敗: ${error.message}`;
    }
    throw new Error(errorMessage);
  }
};

export const generateSpeech = async (textToSpeak: string): Promise<string> => {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: textToSpeak }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' }, // 選擇一個活潑的聲音
          },
        },
      },
    });
    
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (base64Audio) {
      return base64Audio;
    } else {
      throw new Error("API 未返回有效的音訊資料。");
    }

  } catch (error) {
    console.error("呼叫 Gemini TTS API 時發生錯誤:", error);
    throw new Error("生成語音失敗，請稍後再試。");
  }
};

export const summarizeScript = async (script: string): Promise<string> => {
    const prompt = `
      請將以下講稿濃縮成 2 到 4 個條列式的重點。
      每個重點都應該簡潔有力，並以 '• ' 開頭。
      你的回答只能包含這些條列式重點，不要有任何前言或結語。

      講稿：
      ---
      ${script}
      ---
    `;

    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
      });
      return response.text.trim();
    } catch (error) {
      console.error("呼叫 Gemini API 進行講稿摘要時發生錯誤:", error);
      throw new Error("生成講稿重點失敗，請稍後再試。");
    }
};

export const askQuestionAboutDocument = async (documentContext: string, question: string): Promise<string> => {
  const prompt = `
    你是一位專業、友善的文件問答助理。
    你的任務是根據我提供的「文件內容」來精確地回答問題。
    請只使用文件內容中的資訊來回答。
    如果答案不在文件內容中，請誠實地回答：「根據我所擁有的文件內容，我找不到相關資訊。」
    請以繁體中文、清晰且有條理的方式回答。

    ---
    文件內容：
    ${documentContext}
    ---

    使用者的問題：
    ${question}
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: prompt,
    });
    return response.text;
  } catch (error) {
    console.error("呼叫 Gemini API 進行問答時發生錯誤:", error);
    throw new Error("與 AI 助理對話時發生錯誤，請稍後再試。");
  }
};
