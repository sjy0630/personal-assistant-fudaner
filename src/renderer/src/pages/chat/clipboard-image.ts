/** 读字节期间若草稿已清除或附件已移除，停止后续导入。 */
export async function uploadClipboardImage<T>(file: { name: string; arrayBuffer(): Promise<ArrayBuffer> }, active: () => boolean,
  upload: (name: string, bytes: Uint8Array) => Promise<T>): Promise<T> {
  const bytes = await file.arrayBuffer();
  if (!active()) throw new Error('图片导入已取消。');
  return upload(file.name, new Uint8Array(bytes));
}
