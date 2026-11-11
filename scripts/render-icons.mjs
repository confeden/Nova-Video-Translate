import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const root = new URL('../apps/extension/public/icon/', import.meta.url);
for (const size of [16, 32, 48, 96, 128]) {
  await sharp(fileURLToPath(new URL('icon.svg', root))).resize(size, size).png().toFile(fileURLToPath(new URL(`${size}.png`, root)));
}
