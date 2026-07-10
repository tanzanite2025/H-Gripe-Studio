export const NODE_CARD_WIDTH = 480;
export const NODE_COLUMN_GAP = NODE_CARD_WIDTH + 80;
export const IMAGE_SOURCE_MAX_VISIBLE_SLOTS = 5;
export const IMAGE_SOURCE_PREVIEW_SIZE = 300;
export const IMAGE_SOURCE_TILE_WIDTH = 316;
export const IMAGE_SOURCE_THUMB_SIZE = IMAGE_SOURCE_PREVIEW_SIZE;
export const IMAGE_SOURCE_THUMB_MODE = "contain_square" as const;
export const IMAGE_SOURCE_MEDIA_GAP = 8;
export const IMAGE_SOURCE_BODY_X_PADDING = 16;

export function imageSourceCardWidthForSlots(slotCount: number): number {
  const visibleSlots = Math.min(
    IMAGE_SOURCE_MAX_VISIBLE_SLOTS,
    Math.max(1, Math.floor(slotCount)),
  );
  return (
    visibleSlots * IMAGE_SOURCE_TILE_WIDTH +
    Math.max(0, visibleSlots - 1) * IMAGE_SOURCE_MEDIA_GAP +
    IMAGE_SOURCE_BODY_X_PADDING
  );
}

export const IMAGE_SOURCE_CARD_WIDTH = imageSourceCardWidthForSlots(
  IMAGE_SOURCE_MAX_VISIBLE_SLOTS,
);
export const IMAGE_SOURCE_COLUMN_GAP = IMAGE_SOURCE_CARD_WIDTH + 80;
