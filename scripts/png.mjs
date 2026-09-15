import { deflateSync } from 'node:zlib';
import { composite } from '../web/lib/model.js';

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const tag = Buffer.from(type);
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  tag.copy(result, 4); data.copy(result, 8);
  result.writeUInt32BE(crc32(Buffer.concat([tag, data])), result.length - 4);
  return result;
}
export function encodePng(project, frame = 0, scale = 1) {
  const pixels = composite(project, frame);
  const width = project.width * scale, height = project.height * scale;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (Math.floor(y / scale) * project.width + Math.floor(x / scale)) * 4;
    const dest = y * (width * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 4; c++) rows[dest + c] = pixels[source + c];
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
