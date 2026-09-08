// Minimal ZIP writer for browser-side export bundles.

const UTF8 = new TextEncoder();

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
    }
    return table;
})();

const STREAM_CHUNK_SIZE = 2 * 1024 * 1024;
const YIELD_CHUNK_MIN_BYTES = 256 * 1024;
const ZIP32_MAX = 0xFFFFFFFF;
const ZIP16_MAX = 0xFFFF;
const ZIP64_EXTRA_ID = 0x0001;
const ZIP_VERSION_DEFAULT = 20;
const ZIP_VERSION_ZIP64 = 45;

function updateCrc32(crc, bytes) {
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
    return crc;
}

function finishCrc32(crc) {
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function concat(parts) {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    return { dosTime, dosDate };
}

function writeHeader(size) {
    return new Uint8Array(size);
}

function assertZipNumber(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} is too large for browser-side ZIP export`);
    }
    return value;
}

function needsZip64(value) {
    return value > ZIP32_MAX;
}

function zip32Value(value) {
    assertZipNumber(value, 'ZIP field');
    return needsZip64(value) ? ZIP32_MAX : value;
}

function zip16Value(value) {
    assertZipNumber(value, 'ZIP field');
    return value > ZIP16_MAX ? ZIP16_MAX : value;
}

function setUint64(view, offset, value) {
    assertZipNumber(value, 'ZIP64 field');
    const low = value >>> 0;
    const high = Math.floor(value / 0x100000000) >>> 0;
    view.setUint32(offset, low, true);
    view.setUint32(offset + 4, high, true);
}

function makeZip64Extra(values) {
    const extra = writeHeader(4 + values.length * 8);
    const view = new DataView(extra.buffer);
    view.setUint16(0, ZIP64_EXTRA_ID, true);
    view.setUint16(2, values.length * 8, true);
    values.forEach((value, i) => setUint64(view, 4 + i * 8, value));
    return extra;
}

function normalizeBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

async function yieldToBrowser() {
    await new Promise(resolve => setTimeout(resolve, 0));
}

async function yieldAfterChunk(bytes) {
    if (bytes.length >= YIELD_CHUNK_MIN_BYTES) await yieldToBrowser();
}

function zipProgress(onProgress, fileIndex, fileCount, filePct, label) {
    if (!onProgress) return;
    onProgress((fileIndex + filePct) / fileCount * 100, label);
}

async function readStoredPayload(data, fileIndex, fileCount, name, onProgress) {
    let payloadParts = [];
    let size = 0;
    let crc = 0xFFFFFFFF;

    const readChunk = async (chunk, totalSize) => {
        const bytes = normalizeBytes(chunk);
        size += bytes.length;
        crc = updateCrc32(crc, bytes);
        const ratio = totalSize ? Math.min(1, size / totalSize) : 0;
        zipProgress(onProgress, fileIndex, fileCount, ratio * 0.9, `正在校验 ${name} (${Math.round(ratio * 100)}%)`);
        await yieldAfterChunk(bytes);
    };

    if (data instanceof Uint8Array || data instanceof ArrayBuffer) {
        const bytes = normalizeBytes(data);
        payloadParts = [bytes];
        for (let offset = 0; offset < bytes.length; offset += STREAM_CHUNK_SIZE) {
            await readChunk(bytes.subarray(offset, offset + STREAM_CHUNK_SIZE), bytes.length);
        }
    } else if (typeof Blob !== 'undefined' && data instanceof Blob) {
        payloadParts = [data];
        for (let offset = 0; offset < data.size; offset += STREAM_CHUNK_SIZE) {
            const slice = data.slice(offset, offset + STREAM_CHUNK_SIZE);
            await readChunk(await slice.arrayBuffer(), data.size);
        }
    } else {
        const bytes = UTF8.encode(String(data ?? ''));
        payloadParts = [bytes];
        await readChunk(bytes, bytes.length);
    }

    zipProgress(onProgress, fileIndex, fileCount, 0.9, `正在写入 ${name}`);
    return { payloadParts, size, crc: finishCrc32(crc) };
}

async function readPayloadBytes(data, fileIndex, fileCount, name, onProgress) {
    const payload = await readStoredPayload(data, fileIndex, fileCount, name, onProgress);
    return { bytes: concat(payload.payloadParts), size: payload.size, crc: payload.crc };
}

async function deflateRaw(bytes) {
    if (typeof CompressionStream !== 'function') return null;
    try {
        const stream = new CompressionStream('deflate-raw');
        const writer = stream.writable.getWriter();
        await writer.write(bytes);
        await writer.close();
        return new Uint8Array(await new Response(stream.readable).arrayBuffer());
    } catch (_) {
        return null;
    }
}

function shouldCompress(file) {
    if (file.compress === false) return false;
    if (typeof Blob !== 'undefined' && file.data instanceof Blob) return false;
    if (/\.(png|obj|ply|gltf)$/i.test(file.path)) return false;
    return true;
}

export async function createZipBlob(files, onProgress) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    const fileCount = files.length || 1;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = String(file.path || `file-${i}`).replace(/\\/g, '/').replace(/^\/+/, '');
        const nameBytes = UTF8.encode(name);
        if (nameBytes.length > ZIP16_MAX) {
            throw new Error(`ZIP filename is too long: ${name}`);
        }
        zipProgress(onProgress, i, fileCount, 0, `正在读取 ${name}`);

        const compressCandidate = shouldCompress(file);
        const raw = compressCandidate
            ? await readPayloadBytes(file.data, i, fileCount, name, onProgress)
            : await readStoredPayload(file.data, i, fileCount, name, onProgress);

        let payloadParts = raw.payloadParts || [raw.bytes];
        let payloadSize = raw.size;
        let compressed = null;
        if (compressCandidate) {
            zipProgress(onProgress, i, fileCount, 0.92, `正在压缩 ${name}`);
            compressed = await deflateRaw(raw.bytes);
        }
        const useCompressed = compressed && compressed.length < raw.size;
        if (useCompressed) {
            payloadParts = [compressed];
            payloadSize = compressed.length;
        }
        const method = useCompressed ? 8 : 0;
        const { dosTime, dosDate } = dosDateTime(file.date);
        assertZipNumber(raw.size, `${name} source size`);
        assertZipNumber(payloadSize, `${name} compressed size`);
        assertZipNumber(offset, `${name} offset`);

        const sizesNeedZip64 = needsZip64(raw.size) || needsZip64(payloadSize);
        const localExtra = sizesNeedZip64 ? makeZip64Extra([raw.size, payloadSize]) : new Uint8Array(0);
        const localVersion = sizesNeedZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_DEFAULT;

        const local = writeHeader(30 + nameBytes.length + localExtra.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, localVersion, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, method, true);
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, raw.crc, true);
        lv.setUint32(18, sizesNeedZip64 ? ZIP32_MAX : payloadSize, true);
        lv.setUint32(22, sizesNeedZip64 ? ZIP32_MAX : raw.size, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, localExtra.length, true);
        local.set(nameBytes, 30);
        local.set(localExtra, 30 + nameBytes.length);
        locals.push(local, ...payloadParts);

        const centralZip64Values = [];
        const centralNeedsZip64 = sizesNeedZip64 || needsZip64(offset);
        if (sizesNeedZip64) centralZip64Values.push(raw.size, payloadSize);
        if (needsZip64(offset)) centralZip64Values.push(offset);
        const centralExtra = centralNeedsZip64 ? makeZip64Extra(centralZip64Values) : new Uint8Array(0);

        const central = writeHeader(46 + nameBytes.length + centralExtra.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, centralNeedsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_DEFAULT, true);
        cv.setUint16(6, centralNeedsZip64 ? ZIP_VERSION_ZIP64 : ZIP_VERSION_DEFAULT, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, method, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, raw.crc, true);
        cv.setUint32(20, sizesNeedZip64 ? ZIP32_MAX : payloadSize, true);
        cv.setUint32(24, sizesNeedZip64 ? ZIP32_MAX : raw.size, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, centralExtra.length, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, needsZip64(offset) ? ZIP32_MAX : offset, true);
        central.set(nameBytes, 46);
        central.set(centralExtra, 46 + nameBytes.length);
        centrals.push(central);

        offset += local.length + payloadSize;
        assertZipNumber(offset, 'ZIP archive size');
        zipProgress(onProgress, i, fileCount, 1, `已打包 ${name}`);
        if (onProgress && (i % 8 === 7 || i === files.length - 1)) await yieldToBrowser();
    }

    const centralOffset = offset;
    const centralDir = concat(centrals);
    assertZipNumber(centralDir.length, 'ZIP central directory size');
    const needsZip64End = files.length > ZIP16_MAX || needsZip64(centralDir.length) || needsZip64(centralOffset);
    const tail = [];

    if (needsZip64End) {
        const zip64EocdOffset = centralOffset + centralDir.length;
        assertZipNumber(zip64EocdOffset, 'ZIP64 end of central directory offset');

        const zip64End = writeHeader(56);
        const zv = new DataView(zip64End.buffer);
        zv.setUint32(0, 0x06064b50, true);
        setUint64(zv, 4, 44);
        zv.setUint16(12, ZIP_VERSION_ZIP64, true);
        zv.setUint16(14, ZIP_VERSION_ZIP64, true);
        zv.setUint32(16, 0, true);
        zv.setUint32(20, 0, true);
        setUint64(zv, 24, files.length);
        setUint64(zv, 32, files.length);
        setUint64(zv, 40, centralDir.length);
        setUint64(zv, 48, centralOffset);

        const locator = writeHeader(20);
        const lv = new DataView(locator.buffer);
        lv.setUint32(0, 0x07064b50, true);
        lv.setUint32(4, 0, true);
        setUint64(lv, 8, zip64EocdOffset);
        lv.setUint32(16, 1, true);
        tail.push(zip64End, locator);
    }

    const end = writeHeader(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, zip16Value(files.length), true);
    ev.setUint16(10, zip16Value(files.length), true);
    ev.setUint32(12, zip32Value(centralDir.length), true);
    ev.setUint32(16, zip32Value(centralOffset), true);
    ev.setUint16(20, 0, true);
    tail.push(end);

    return new Blob([...locals, centralDir, ...tail], { type: 'application/zip' });
}

export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
