import JSZip from 'jszip';

/** 部分导出器省略默认文字样式，预览器要求该节点存在。仅补充预览副本。 */
export async function preparePresentation(bytes: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(bytes);
  const entry = zip.file('ppt/presentation.xml');
  if (!entry) throw new Error('PPTX 缺少演示文稿内容。');
  const xml = await entry.async('string');
  if (/<p:defaultTextStyle[\s>]/.test(xml)) return bytes;
  const style = '<p:defaultTextStyle><a:defPPr><a:defRPr/></a:defPPr></p:defaultTextStyle>';
  zip.file('ppt/presentation.xml', xml.replace('</p:presentation>', `${style}</p:presentation>`));
  return zip.generateAsync({ type: 'uint8array' });
}
