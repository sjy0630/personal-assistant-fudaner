import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { normalizeImage } from '../src/main/library/images';

const fixture = (name: string) => readFile(join('tests/fixtures/images', name));

describe('本地图片规范化', () => {
  it.each([
    ['png', 'png'], ['jpg', 'jpeg'], ['jpeg', 'jpeg'], ['webp', 'webp'],
    ['gif', 'gif'], ['bmp', 'bmp'], ['tif', 'tiff'], ['tiff', 'tiff'],
    ['avif', 'avif'], ['svg', 'svg'], ['heic', 'heic'], ['heif', 'heic'],
  ])('真实 %s 图片转成可解码的安全像素', async (extension, source) => {
    const result = await normalizeImage(await fixture(`sample.${source}`), `.${extension}`);
    expect(['image/png', 'image/jpeg']).toContain(result.mime);
    expect([result.width, result.height]).toEqual([12, 8]);
    const { data, info } = await sharp(result.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([12, 8]);
    // The fixture is red: this catches incorrect BMP ABGR/RGBA conversion too.
    expect(data[0]).toBeGreaterThan(180);
    expect(data[1]).toBeLessThan(80);
    expect(data[2]).toBeLessThan(80);
  });

  it('自动校正 EXIF 旋转并去掉源文件元数据', async () => {
    const result = await normalizeImage(await fixture('oriented.jpeg'), '.JPG');
    expect([result.width, result.height]).toEqual([8, 12]);
    expect((await sharp(result.data).metadata()).orientation).toBeUndefined();
  });

  it('HEIC 仅提供 EXIF 方向时也能正确旋转', async () => {
    const result = await normalizeImage(await fixture('oriented.heic'), '.heic');
    expect([result.width, result.height]).toEqual([8, 12]);
    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  });

  it.each([['animated.gif', '.gif'], ['multipage.tiff', '.tiff']])('只取 %s 第一帧/页并给出提示', async (name, extension) => {
    const result = await normalizeImage(await fixture(name), extension);
    expect(result.note).toMatch(/首|第一/);
    const { data } = await sharp(result.data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBeGreaterThan(180);
    expect(data[2]).toBeLessThan(80);
    expect((await sharp(result.data).metadata()).pages ?? 1).toBe(1);
  });

  it('限制最长边至 2048，保留宽高比和透明度，不放大小图片', async () => {
    const source = await sharp({ create: { width: 4096, height: 1024, channels: 4, background: '#ff000080' } }).png().toBuffer();
    const result = await normalizeImage(source, '.png');
    expect([result.width, result.height]).toEqual([2048, 512]);
    expect((await sharp(result.data).metadata()).hasAlpha).toBe(true);
    const { data } = await sharp(result.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBeCloseTo(128, -1);
  });

  it('按真实格式核验扩展名，拒绝伪装或损坏文件', async () => {
    await expect(normalizeImage(await fixture('sample.png'), '.jpeg')).rejects.toThrow(/格式|扩展名/);
    await expect(normalizeImage(Buffer.from('fake image'), '.png')).rejects.toThrow(/图片|图像/);
    await expect(normalizeImage((await fixture('sample.png')).subarray(0, 40), '.png')).rejects.toThrow();
    await expect(normalizeImage(await fixture('sample.png'), '.exe')).rejects.toThrow(/支持/);
  });

  it('在解码前拒绝过大输入和异常尺寸', async () => {
    await expect(normalizeImage(Buffer.alloc(25 * 1024 * 1024 + 1), '.png')).rejects.toThrow(/大小|25/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="40000" height="1"/>');
    await expect(normalizeImage(svg, '.svg')).rejects.toThrow(/尺寸|像素|超/);
    const pixels = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>');
    await expect(normalizeImage(pixels, '.svg')).rejects.toThrow(/尺寸|像素|超/);
    const bmp = await fixture('sample.bmp');
    bmp.writeInt32LE(100000, 18);
    await expect(normalizeImage(bmp, '.bmp')).rejects.toThrow(/尺寸|像素|超/);
  });

  it.each([
    '<image href="https://example.com/private.png"/>',
    '<image href="file:///etc/passwd"/>',
    '<image href="data:image/svg+xml;base64,PHN2Zy8+"/>',
    '<use href="https&#58;//example.com/a.svg#x"/>',
    '<rect style="fill:url(https://example.com/a.svg#x)"/>',
    '<style>@import "https://example.com/a.css";</style>',
    '<style>rect { fill: u\\72l(https://example.com/a); }</style>',
    '<script>alert(1)</script>',
    '<foreignObject><div>active markup</div></foreignObject>',
    '<rect onclick="alert(1)"/>',
  ])('SVG 拒绝活动内容和外部资源 %s', async (body) => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8">${body}</svg>`);
    await expect(normalizeImage(svg, '.svg')).rejects.toThrow(/SVG|外部|安全/);
  });

  it('拒绝 SVG 的外部实体和处理指令，保留安全内部渐变引用', async () => {
    await expect(normalizeImage(Buffer.from('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>'), '.svg')).rejects.toThrow(/SVG|安全/);
    await expect(normalizeImage(Buffer.from('<?xml-stylesheet href="https://example.com/x.css"?><svg/>'), '.svg')).rejects.toThrow(/SVG|安全/);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="12" height="8"><defs><linearGradient id="red"><stop stop-color="red"/></linearGradient></defs><rect width="12" height="8" fill="url(#red)"/></svg>');
    const result = await normalizeImage(svg, '.svg');
    expect(result.mime).toBe('image/png');
    expect(result.data.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });
});
