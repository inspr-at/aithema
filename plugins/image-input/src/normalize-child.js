import sharp from 'sharp';
// Permission mode supplies read-only module paths and no network or write grants.
sharp.cache(false);
sharp.concurrency(1);
const refuse = reason => ({ status: 'staged-refused', reason });
process.once('message', async ({ bytes, extension }) => {
  let result;
  try {
    const input = Buffer.from(bytes), settings = { limitInputPixels: 40_000_000, pages: 1, page: 0, animated: false, failOn: 'warning', sequentialRead: true };
    const image = sharp(input, settings), metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(metadata.format) || extension && (extension === 'jpg' ? 'jpeg' : extension) !== metadata.format) result = refuse('unsupported');
    else if (!metadata.width || !metadata.height || metadata.width > 16384 || metadata.height > 16384 || metadata.width * metadata.height > 40_000_000) result = refuse('dimensions');
    else {
      const rotate = [5, 6, 7, 8].includes(metadata.orientation), w = rotate ? metadata.height : metadata.width, h = rotate ? metadata.width : metadata.height;
      const scale = Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1_150_000 / (w * h)));
      const pipeline = image.autoOrient().resize({ width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)), fit: 'inside', withoutEnlargement: true });
      const { data, info } = await (metadata.hasAlpha ? pipeline.png() : pipeline.jpeg({ quality: 85 })).toBuffer({ resolveWithObject: true });
      result = data.length > 8 * 1024 * 1024 ? refuse('limit') : { status: 'staged-ready', bytes: data, mediaType: `image/${info.format}`, w: info.width, h: info.height };
    }
  } catch (error) { result = refuse(/pixel limit|dimensions|too large/iu.test(error.message) ? 'dimensions' : 'malformed'); }
  process.send?.(result, () => { process.disconnect(); });
});
