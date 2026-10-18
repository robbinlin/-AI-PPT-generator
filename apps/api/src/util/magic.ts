import type { SourceKind } from "@lvs/shared";

export const SOURCE_MIME: Record<SourceKind, string> = {
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ppt: "application/vnd.ms-powerpoint",
  pdf: "application/pdf",
};

/**
 * Detect the deck format from the first bytes of the file. `head` should hold at least the
 * first 64 KiB so OOXML entry names ("ppt/…") are visible; the extension breaks ties for
 * zip containers whose first entries are not under ppt/.
 */
export function sniffSourceKind(head: Buffer, filename: string): SourceKind | null {
  if (head.length >= 4 && head.subarray(0, 4).toString("latin1") === "%PDF") return "pdf";
  if (head.length >= 8 && head.readUInt32BE(0) === 0xd0cf11e0 && head.readUInt32BE(4) === 0xa1b11ae1) {
    return "ppt";
  }
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const text = head.toString("latin1");
    if (text.includes("ppt/")) return "pptx";
    if (text.includes("word/") || text.includes("xl/")) return null;
    if (/\.pptx$/i.test(filename) && text.includes("[Content_Types].xml")) return "pptx";
  }
  return null;
}
