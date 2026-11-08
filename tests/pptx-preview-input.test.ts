import { expect, it } from 'vitest';
import JSZip from 'jszip';
import { preparePresentation } from '../src/renderer/src/components/pptx-input';
it('补齐缺省文字样式，保留原始幻灯片', async () => {
  const zip = new JSZip();
  zip.file('ppt/presentation.xml', '<p:presentation xmlns:a="a" xmlns:p="p"></p:presentation>');
  zip.file('ppt/slides/slide1.xml', '<slide>original</slide>');
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  const prepared = await JSZip.loadAsync(await preparePresentation(bytes));
  expect(await prepared.file('ppt/presentation.xml')!.async('string')).toContain('<p:defaultTextStyle>');
  expect(await prepared.file('ppt/slides/slide1.xml')!.async('string')).toBe('<slide>original</slide>');
  expect(await (await JSZip.loadAsync(bytes)).file('ppt/presentation.xml')!.async('string')).not.toContain('defaultTextStyle');
});
