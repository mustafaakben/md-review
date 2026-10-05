export interface PopupBox { left: number; top: number; width: number; height: number }
export function clampPopup(box: PopupBox, width: number, height: number): PopupBox {
  const w = Math.min(Math.max(260, box.width), Math.max(100, width - 24));
  const h = Math.min(Math.max(180, box.height), Math.max(100, height - 76));
  return { width: w, height: h, left: Math.max(12, Math.min(width - w - 12, box.left)), top: Math.max(64, Math.min(height - h - 12, box.top)) };
}
export function resizePopup(box: PopupBox, edge: string, dx: number, dy: number, width: number, height: number): PopupBox {
  let { left, top } = box;
  let right = left + box.width, bottom = top + box.height;
  const minW = Math.min(260, width - 24), minH = Math.min(180, height - 76);
  if (edge.includes('w')) left = Math.max(12, Math.min(right - minW, left + dx));
  if (edge.includes('e')) right = Math.min(width - 12, Math.max(left + minW, right + dx));
  if (edge.includes('n')) top = Math.max(64, Math.min(bottom - minH, top + dy));
  if (edge.includes('s')) bottom = Math.min(height - 12, Math.max(top + minH, bottom + dy));
  return clampPopup({ left, top, width: right - left, height: bottom - top }, width, height);
}
