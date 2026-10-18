# Benchmark: VoAI 虛擬人簡報 (app.voai.ai, Oct 2026)

Observed flow: 上傳 PDF → 選擇角色頭像／聲音 → 確認文稿（逐頁）→ 生成下載（影片無字幕 / 含字幕 / 字幕檔）。
Editor: left page list with thumbnails + first script line; centre slide preview with a circular
avatar fixed bottom-right; below it the per-page script box (500-char limit, "AI 生成" rewrite,
"靜音" toggle, character name). Desktop browsers only. PDF only. One project at a time
(project list "開發中"). Billing: 簡報影片 2 points/second, separate from avatar short videos.

| Area | VoAI | This project (v1) | This project (v2) |
|---|---|---|---|
| Input | PDF | PPTX / PPT / PDF incl. speaker notes | + Google Slides import |
| Script | per page, independent | whole-deck outline + glossary, then per page with neighbours | effects bound to sentences |
| Settings | character, voice | audience, mode, duration, language, boundary, pronunciation dictionary | – |
| Avatar | fixed circle bottom-right | size / anchor / hide per scene, provider-agnostic | personal likeness with licence record |
| Editing | per-page text, mute | + reorder, hide, pause, transition, subtitle style | multi-track timeline, zoom/highlight |
| Regeneration | rewrite page; re-merge whole video | hash-based: only stale assets regenerate; scene renders cached | – |
| Subtitles | auto, burn-in or SRT | from TTS timestamps, burn-in and SRT, formal vs spoken text | word highlight |
| Providers | in-house | Gemini / Anthropic LLM, Gemini / ElevenLabs TTS, HeyGen avatar, BYO keys | more |
| Projects | one | many, versioned scripts | collaboration / review |

v1 goal = VoAI parity + the three differentiators: PPTX with notes, outline-first scripts
with pronunciation, hash-based partial regeneration.
