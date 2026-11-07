import sharp, { type Sharp } from 'sharp';
import { load } from 'cheerio';
import bmp from 'bmp-js';
import decodeHeic from 'heic-decode';

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_EDGE = 32_768;
const MAX_OUTPUT_EDGE = 2048;
const FORMATS: Record<string, string> = {
  png: 'png', jpg: 'jpeg', jpeg: 'jpeg', webp: 'webp', gif: 'gif',
  bmp: 'bmp', tif: 'tiff', tiff: 'tiff', avif: 'avif', svg: 'svg',
  heic: 'heic', heif: 'heic',
};

export interface NormalizedImage {
  data: Buffer;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  note?: string;
}

function checkDimensions(width: number | undefined, height: number | undefined): void {
  if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height)
    || width < 1 || height < 1 || width > MAX_INPUT_EDGE || height > MAX_INPUT_EDGE
    || width * height > MAX_INPUT_PIXELS) {
    throw new Error('图片尺寸或像素数超限（最多 4000 万像素，单边不超过 32768）');
  }
}

// SVG is never stored/displayed as markup. Restrict the renderer input as well,
// so local files, nested SVGs, web resources and active content cannot be loaded.
function safeSvg(buffer: Buffer): Buffer {
  const xml = buffer.toString('utf8');
  const unsafe = () => new Error('SVG 包含不安全内容或外部资源，请先导出为 PNG/JPEG');
  if (buffer.length > 2 * 1024 * 1024 || xml.includes('\0') || /<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)
    || /<\?(?!xml\s[^?]*\?>)/i.test(xml)) throw unsafe();
  const $ = load(xml, { xmlMode: true });
  const roots = $.root().children();
  if (roots.length !== 1 || roots[0].type !== 'tag' || roots[0].name !== 'svg') throw unsafe();
  const allowed = new Set([
    'svg', 'g', 'defs', 'title', 'desc', 'metadata', 'path', 'rect', 'circle', 'ellipse',
    'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'use', 'symbol',
    'clippath', 'mask', 'lineargradient', 'radialgradient', 'stop', 'pattern', 'style',
  ]);
  const nodes = $('*');
  if (nodes.length > 50_000) throw unsafe();
  function checkCss(value: string): void {
    // CSS escapes and at-rules can obscure resource references. Local paint /
    // clipping references are useful and do not need network or filesystem I/O.
    if (/[\\@]/.test(value)) throw unsafe();
    for (const match of value.matchAll(/url\s*\(([^)]*)\)/gi)) {
      if (!/^\s*(['"]?)#[\w:.-]+\1\s*$/.test(match[1])) throw unsafe();
    }
  }
  nodes.each((_, element) => {
    if (element.type !== 'tag' && element.type !== 'style') throw unsafe();
    const name = element.name.toLowerCase();
    if (!allowed.has(name)) throw unsafe();
    for (const [attribute, value] of Object.entries(element.attribs)) {
      if (/(^|:)on/i.test(attribute) || attribute.toLowerCase() === 'xml:base') throw unsafe();
      if (/(^|:)(?:href|src)$/i.test(attribute) && !/^#[\w:.-]+$/.test(value)) throw unsafe();
      checkCss(value);
    }
    if (name === 'style') checkCss($(element).text());
  });
  return Buffer.from($.xml());
}

function decodeBmp(buffer: Buffer): { data: Buffer; width: number; height: number } {
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') throw new Error('BMP 图片已损坏或格式错误');
  const headerSize = buffer.readUInt32LE(14);
  const width = buffer.readInt32LE(18);
  const height = Math.abs(buffer.readInt32LE(22));
  checkDimensions(width, height);
  const bits = buffer.readUInt16LE(28);
  const colors = buffer.readUInt32LE(46);
  const offset = buffer.readUInt32LE(10);
  // bmp-js' legacy bitfield/RLE readers are permissive. Only feed fully bounded
  // BI_RGB rows, a validated palette and a normalized BITMAPINFOHEADER to it.
  if (headerSize < 40 || headerSize + 14 > buffer.length || buffer.readUInt16LE(26) !== 1
    || ![1, 4, 8, 16, 24, 32].includes(bits) || buffer.readUInt32LE(30) !== 0) {
    throw new Error('暂不支持此 BMP 编码，请导出为未压缩 BMP 或 PNG/JPEG');
  }
  const paletteSize = bits <= 8 ? (colors || (1 << bits)) * 4 : 0;
  const pixelBytes = Math.ceil(width * bits / 32) * 4 * height;
  if ((bits <= 8 && colors > (1 << bits)) || offset < 14 + headerSize + paletteSize
    || offset + pixelBytes > buffer.length) throw new Error('BMP 图片像素数据不完整');
  const header = Buffer.from(buffer.subarray(0, 54));
  header.writeUInt32LE(40, 14);
  header.writeUInt32LE(54 + paletteSize, 10);
  const bounded = Buffer.concat([
    header, buffer.subarray(14 + headerSize, 14 + headerSize + paletteSize),
    buffer.subarray(offset, offset + pixelBytes),
  ]);
  const decoded = bmp.decode(bounded);
  const data = Buffer.alloc(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    data[pixel * 3] = decoded.data[pixel * 4 + 3];
    data[pixel * 3 + 1] = decoded.data[pixel * 4 + 2];
    data[pixel * 3 + 2] = decoded.data[pixel * 4 + 1];
  }
  return { data, width, height };
}

function exifOrientation(exif?: Buffer): number {
  if (!exif || exif.length < 14 || exif.toString('ascii', 0, 6) !== 'Exif\0\0') return 1;
  const tiff = exif.subarray(6);
  const order = tiff.toString('ascii', 0, 2);
  if (order !== 'II' && order !== 'MM') return 1;
  const u16 = (offset: number) => order === 'II' ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset);
  const u32 = (offset: number) => order === 'II' ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset);
  if (u16(2) !== 42) return 1;
  const ifd = u32(4);
  if (ifd + 2 > tiff.length) return 1;
  const count = u16(ifd);
  if (ifd + 2 + count * 12 > tiff.length) return 1;
  for (let i = 0; i < count; i++) {
    const offset = ifd + 2 + i * 12;
    if (u16(offset) === 0x112 && u16(offset + 2) === 3 && u32(offset + 4) === 1) {
      const orientation = u16(offset + 8);
      return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
  }
  return 1;
}

function hasHeifTransform(buffer: Buffer, start = 0, end = buffer.length, depth = 0): boolean {
  for (let offset = start; offset + 8 <= end;) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return false;
      const largeSize = buffer.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(end - offset)) return false;
      size = Number(largeSize);
      header = 16;
    }
    if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return false;
    if (type === 'irot' || type === 'imir') return true;
    if (depth < 3 && ['meta', 'iprp', 'ipco'].includes(type)
      && hasHeifTransform(buffer, offset + header + (type === 'meta' ? 4 : 0), offset + size, depth + 1)) return true;
    offset += size;
  }
  return false;
}

function orientHeic(pipeline: Sharp, orientation: number): Sharp {
  // HEIF container irot/imir transforms are already applied by libheif. Some
  // older exports have EXIF alone; raw pixel input needs that applied explicitly.
  switch (orientation) {
    case 2: return pipeline.flop();
    case 3: return pipeline.rotate(180);
    case 4: return pipeline.flip();
    case 5: return pipeline.flip().rotate(90);
    case 6: return pipeline.rotate(90);
    case 7: return pipeline.flop().rotate(90);
    case 8: return pipeline.rotate(270);
    default: return pipeline;
  }
}

async function encode(pipeline: Sharp, note?: string): Promise<NormalizedImage> {
  const { data, info } = await pipeline.autoOrient()
    .resize({ width: MAX_OUTPUT_EDGE, height: MAX_OUTPUT_EDGE, fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb').png().timeout({ seconds: 15 }).toBuffer({ resolveWithObject: true });
  return { data, mime: 'image/png', width: info.width, height: info.height, ...(note ? { note } : {}) };
}

/** Decode locally into metadata-free pixels; no source image paths or active markup escape. */
export async function normalizeImage(buffer: Buffer, extension: string): Promise<NormalizedImage> {
  const format = FORMATS[extension.replace(/^\./, '').toLowerCase()];
  if (!format) throw new Error(`暂不支持的图片类型：${extension}`);
  if (!buffer.length) throw new Error('图片文件为空');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('图片大小超过 25 MB 限制');
  try {
    if (format === 'bmp') {
      const decoded = decodeBmp(buffer);
      return await encode(sharp(decoded.data, { raw: { width: decoded.width, height: decoded.height, channels: 3 } }));
    }
    const input = format === 'svg' ? safeSvg(buffer) : buffer;
    const pipeline = sharp(input, { failOn: 'warning', limitInputPixels: MAX_INPUT_PIXELS, pages: 1, page: 0 });
    const metadata = await pipeline.metadata();
    const detected = metadata.format === 'heif' ? (metadata.compression === 'av1' ? 'avif' : 'heic') : metadata.format;
    if (detected !== format) throw new Error('图片实际格式与扩展名不一致');
    checkDimensions(metadata.width, metadata.height);
    let note = (metadata.pages ?? 1) > 1 ? '多帧/多页图片仅使用第一帧或第一页。' : undefined;
    if (format === 'heic') {
      // all() reads dimensions without allocating RGBA pixels. Always free its
      // native JS decoder resources, including on validation/decode failures.
      const images = await decodeHeic.all({ buffer });
      try {
        if (!images.length) throw new Error('HEIC 图片中没有可解码画面');
        checkDimensions(images[0].width, images[0].height);
        const image = await images[0].decode();
        checkDimensions(image.width, image.height);
        if (images.length > 1) note = 'HEIC/HEIF 图片仅使用第一幅画面。';
        const raw = sharp(Buffer.from(image.data), { raw: { width: image.width, height: image.height, channels: 4 } });
        return await encode(orientHeic(raw, hasHeifTransform(buffer) ? 1 : exifOrientation(metadata.exif)), note);
      } finally { images.dispose(); }
    }
    return await encode(pipeline, note);
  } catch (error) {
    const detail = error instanceof Error ? error.message : '图片已损坏或编码不受支持';
    throw new Error(`无法读取图片：${/pixel limit/i.test(detail) ? '图片像素数超过 4000 万限制' : detail}`);
  }
}
