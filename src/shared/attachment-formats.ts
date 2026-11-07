export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.svg', '.heic', '.heif'] as const;
export const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls'] as const;
export const PRESENTATION_EXTENSIONS = ['.pptx', '.ppt'] as const;
export const ATTACHMENT_EXTENSIONS: readonly string[] = [
  '.pdf', '.docx', '.md', '.markdown', '.txt', '.csv', '.json',
  ...IMAGE_EXTENSIONS, ...SPREADSHEET_EXTENSIONS, ...PRESENTATION_EXTENSIONS,
];
export const ATTACHMENT_ACCEPT = ATTACHMENT_EXTENSIONS.join(',');
export const ATTACHMENT_FORMATS_LABEL = '图片、PDF、Word、Excel、PPT、Markdown 和文本';
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function supportedAttachment(name: string): boolean {
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  return ATTACHMENT_EXTENSIONS.includes(extension);
}
