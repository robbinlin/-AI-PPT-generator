// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { shortcutAllowed } from "./useEditorKeyboard";

afterEach(() => {
  document.body.innerHTML = "";
});

const el = (html: string) => {
  document.body.innerHTML = html;
  return document.body.querySelector<HTMLElement>("[data-t]")!;
};

describe("shortcutAllowed", () => {
  it("lets Space press ordinary buttons and checkboxes", () => {
    expect(shortcutAllowed(el('<button data-t>匯出影片</button>'), " ")).toBe(false);
    expect(shortcutAllowed(el('<input type="checkbox" data-t />'), " ")).toBe(false);
  });

  it("plays with Space when nothing is focused, on a page or on the preview", () => {
    expect(shortcutAllowed(document.body, " ")).toBe(true);
    expect(shortcutAllowed(el('<button data-page-button data-t>第 1 頁</button>'), " ")).toBe(true);
    expect(shortcutAllowed(el('<div data-testid="video-frame"><span data-t></span></div>'), " ")).toBe(true);
  });

  it("keeps out of dialogs, menus and radio groups", () => {
    expect(shortcutAllowed(el('<div role="menu"><button role="menuitem" data-t>隱藏</button></div>'), "ArrowDown")).toBe(false);
    expect(shortcutAllowed(el('<input type="radio" data-t />'), "ArrowDown")).toBe(false);
    expect(shortcutAllowed(el('<div role="dialog" aria-modal="true"><button data-t>更口語</button></div>'), " ")).toBe(false);
  });

  it("never fires while a modal dialog is open, even if focus fell to the page", () => {
    document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>';
    expect(shortcutAllowed(document.body, "ArrowDown")).toBe(false);
  });

  it("moves between pages with the arrows from a page button", () => {
    expect(shortcutAllowed(el('<button data-page-button data-t>第 1 頁</button>'), "ArrowDown")).toBe(true);
  });
});
