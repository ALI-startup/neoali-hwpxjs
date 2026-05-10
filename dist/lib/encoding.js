/**
 * encoding.js
 * Detects and decodes UTF-8 / UTF-16LE / UTF-16BE byte arrays.
 * Used when reading XML files out of the HWPX zip archive.
 */

const DECODER_UTF8    = new TextDecoder("utf-8");
const DECODER_UTF16LE = new TextDecoder("utf-16le");
const DECODER_UTF16BE = new TextDecoder("utf-16be");

/**
 * Detect the text encoding of a byte array.
 * Priority: BOM check → heuristic zero-byte pattern.
 * @param {Uint8Array} bytes
 * @returns {"utf-8"|"utf-16le"|"utf-16be"}
 */
function detectTextEncoding(bytes) {
    // BOM checks
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return "utf-8";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
        return "utf-16le";
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
        return "utf-16be";

    // Heuristic: count zero bytes on even vs odd positions.
    // UTF-16LE: content byte on even, 0x00 on odd  → zeroOdd high
    // UTF-16BE: 0x00 on even, content byte on odd  → zeroEven high
    let zeroEven = 0, zeroOdd = 0;
    const sample = Math.min(bytes.length, 1024);
    for (let i = 0; i < sample; i++) {
        if (bytes[i] === 0) (i % 2 === 0 ? zeroEven++ : zeroOdd++);
    }
    if (zeroOdd   > zeroEven * 2) return "utf-16le";
    if (zeroEven  > zeroOdd  * 2) return "utf-16be";
    return "utf-8";
}

/**
 * Decode a Uint8Array to a string, stripping BOM automatically.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeBytesSmart(bytes) {
    const enc = detectTextEncoding(bytes);
    // Strip BOM before decoding
    if (enc === "utf-8"    && bytes.length >= 3 && bytes[0] === 0xef) return DECODER_UTF8   .decode(bytes.subarray(3));
    if (enc === "utf-16le" && bytes.length >= 2 && bytes[0] === 0xff) return DECODER_UTF16LE.decode(bytes.subarray(2));
    if (enc === "utf-16be" && bytes.length >= 2 && bytes[0] === 0xfe) return DECODER_UTF16BE.decode(bytes.subarray(2));
    if (enc === "utf-8")    return DECODER_UTF8   .decode(bytes);
    if (enc === "utf-16le") return DECODER_UTF16LE.decode(bytes);
    return                         DECODER_UTF16BE.decode(bytes);
}
