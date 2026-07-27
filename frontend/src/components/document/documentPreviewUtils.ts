const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "svg", "gif", "webp", "bmp"];

export function isSpreadsheetType(extension?: string | null) {
  const normalized = (extension || "").toLowerCase();
  return normalized === "xlsx" || normalized === "xls";
}

export function isImageType(extension?: string | null) {
  return IMAGE_EXTENSIONS.includes((extension || "").toLowerCase());
}

export function parseFrontMatter(content: string): { head: string | null; body: string } {
  if (content.startsWith("---\n")) {
    const end = content.indexOf("\n---\n", 4);
    if (end > 0) {
      return { head: content.substring(4, end), body: content.substring(end + 5) };
    }
  }
  return { head: null, body: content };
}
