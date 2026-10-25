import type { CaptureRect } from "../../shared/index.js";

export interface ViewportProbe {
  rect: { x: number; y: number; width: number; height: number };
  scrollX: number;
  scrollY: number;
}

/**
 * Convert an element's viewport-relative rect + page scroll offsets to a
 * document-relative CSS-pixel rect for captureTab (SPEC §3). captureTab crops
 * natively and handles devicePixelRatio, so no canvas math here.
 */
export function toDocumentRect(probe: ViewportProbe): CaptureRect {
  const x = probe.rect.x + probe.scrollX;
  const y = probe.rect.y + probe.scrollY;
  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    width: Math.max(1, Math.round(probe.rect.width)),
    height: Math.max(1, Math.round(probe.rect.height)),
  };
}
