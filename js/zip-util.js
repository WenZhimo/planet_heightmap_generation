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

function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    }
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

async function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
    return UTF8.encode(String(data ?? ''));
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
    if (/\.png$/i.test(file.path)) return false;
    return true;
}

export async function createZipBlob(files, onProgress) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const name = String(file.path || `file-${i}`).replace(/\\/g, '/').replace(/^\/+/, '');
        const nameBytes = UTF8.encode(name);
        const raw = await toBytes(file.data);
        const crc = crc32(raw);
        const compressed = shouldCompress(file) ? await deflateRaw(raw) : null;
        const useCompressed = compressed && compressed.length < raw.length;
        const payload = useCompressed ? compressed : raw;
        const method = useCompressed ? 8 : 0;
        const { dosTime, dosDate } = dosDateTime(file.date);

        const local = writeHeader(30 + nameBytes.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(8, method, true);
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, payload.length, true);
        lv.setUint32(22, raw.length, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true);
        local.set(nameBytes, 30);
        locals.push(local, payload);

        const central = writeHeader(46 + nameBytes.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0x0800, true);
        cv.setUint16(10, method, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, payload.length, true);
        cv.setUint32(24, raw.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centrals.push(central);

        offset += local.length + payload.length;
        if (onProgress) onProgress((i + 1) / files.length * 100, `正在打包 ${name}`);
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    const centralOffset = offset;
    const centralDir = concat(centrals);
    const end = writeHeader(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralDir.length, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...locals, centralDir, end], { type: 'application/zip' });
}

export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}
