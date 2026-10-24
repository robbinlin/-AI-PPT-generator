import type { Announcements, ScreenReaderInstructions, UniqueIdentifier } from "@dnd-kit/core";
import { fmt, t } from "../i18n";

/** dnd-kit's spoken instructions, in Chinese (the default is English). */
export const pageDragInstructions: ScreenReaderInstructions = { draggable: t.dnd.instructions };

/** Spoken drag feedback that names pages by number; `pageOf` maps a slide id to its page number. */
export function pageDragAnnouncements(pageOf: (id: UniqueIdentifier) => number | undefined): Announcements {
  const n = (id: UniqueIdentifier) => pageOf(id) ?? "?";
  return {
    onDragStart: ({ active }) => fmt(t.dnd.pickedUp, { n: n(active.id) }),
    // Still over its own place (right after pick-up): say nothing, so 「已拿起」 is not overwritten.
    onDragOver: ({ active, over }) =>
      !over ? fmt(t.dnd.noTarget, { n: n(active.id) }) : over.id === active.id ? undefined : fmt(t.dnd.over, { n: n(active.id), to: n(over.id) }),
    onDragEnd: ({ active, over }) =>
      over && over.id !== active.id ? fmt(t.dnd.dropped, { n: n(active.id), to: n(over.id) }) : fmt(t.dnd.droppedSame, { n: n(active.id) }),
    onDragCancel: ({ active }) => fmt(t.dnd.cancelled, { n: n(active.id) }),
  };
}
