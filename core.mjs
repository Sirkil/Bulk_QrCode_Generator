const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function parseRecords(input) {
  return input.split(/\r?\n/).map((line, index) => ({data: line.trim(), lineNumber: index + 1})).filter(record => record.data.length > 0);
}

export function fileStem(record) {
  const beforePipe = record.data.split('|', 1)[0].trim();
  let stem = beforePipe.replace(INVALID_FILE_CHARS, '_').replace(/[. ]+$/g, '');
  stem = Array.from(stem).slice(0, 120).join('').replace(/[. ]+$/g, '');
  if (!stem || stem === '.' || stem === '..') stem = `QR ${record.lineNumber}`;
  if (RESERVED_NAME.test(stem)) stem = `_${stem}`;
  return stem;
}

export function validateFolderName(value) {
  const name = value.trim();
  if (!name) throw new Error('Enter a folder name.');
  if (name === '.' || name === '..' || INVALID_FILE_CHARS.test(name) || /[. ]$/.test(name) || RESERVED_NAME.test(name)) {
    INVALID_FILE_CHARS.lastIndex = 0;
    throw new Error('Choose a folder name without special characters or a trailing dot.');
  }
  INVALID_FILE_CHARS.lastIndex = 0;
  return name;
}

export function validateDimension(value, label) {
  const dimension = Number(value);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new Error(`Enter a positive whole number for ${label}.`);
  return dimension;
}

export function apiSizeForDimensions(width, height) {
  return Math.max(10, Math.min(1000, width, height));
}

export function apiUrl(data, size) {
  const url = new URL('https://api.qrserver.com/v1/create-qr-code/');
  url.searchParams.set('size', `${size}x${size}`);
  url.searchParams.set('data', data);
  url.searchParams.set('format', 'png');
  url.searchParams.set('charset-source', 'UTF-8');
  return url.toString();
}

export function uniqueFileName(stem, taken) {
  let name = `${stem}.png`;
  let n = 2;
  while (taken.has(name.toLowerCase())) name = `${stem} (${n++}).png`;
  taken.add(name.toLowerCase());
  return name;
}

export function isPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  return bytes.length >= 8 && signature.every((value, index) => bytes[index] === value);
}

const encoder = new TextEncoder();
const crcTable = Uint32Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipDate(now) {
  const year = Math.max(1980, now.getFullYear());
  return {date: ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate(), time: (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)};
}

export function makeZip(files, folderName) {
  if (files.length > 65535) throw new Error('Too many images for one ZIP file.');
  const local = [], central = [];
  const {date, time} = zipDate(new Date());
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(`${folderName}/${file.name}`);
    const bytes = file.bytes;
    const crc = crc32(bytes);
    const localHeader = new Uint8Array(30 + name.length);
    const localView = new DataView(localHeader.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, bytes.length, true);
    localView.setUint32(22, bytes.length, true);
    localView.setUint16(26, name.length, true);
    localHeader.set(name, 30);
    local.push(localHeader, bytes);

    const centralHeader = new Uint8Array(46 + name.length);
    const centralView = new DataView(centralHeader.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, bytes.length, true);
    centralView.setUint32(24, bytes.length, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    centralHeader.set(name, 46);
    central.push(centralHeader);
    offset += localHeader.length + bytes.length;
  }
  const centralSize = central.reduce((total, item) => total + item.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  return new Blob([...local, ...central, end], {type: 'application/zip'});
}
