export const IMAGE_MEDIA_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "tif",
  "tiff",
  "heic",
  "heif",
  "avif",
] as const;

const IMAGE_MEDIA_EXTENSION_SET = new Set<string>(IMAGE_MEDIA_EXTS);

export function isSupportedImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return IMAGE_MEDIA_EXTENSION_SET.has(path.slice(dot + 1).toLowerCase());
}
