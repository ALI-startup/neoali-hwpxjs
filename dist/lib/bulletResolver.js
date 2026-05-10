/**
 * bulletResolver.js
 * Resolves bullet characters and numbered-list labels for a paragraph.
 *
 * HWPX has two separate list systems, both referenced via paraPr.heading:
 *
 *   type="BULLET"  → literal Unicode character (•, ○, ■, …)
 *                    stored in hh:bullets > hh:bullet[@id, @char]
 *
 *   type="NUMBER"  → generated label from a counter template ("^1.", "^3)", "(^5)")
 *                    stored in hh:numberings > hh:numbering > hh:paraHead
 *
 * Supported numFormat values and their output:
 *   DIGIT                  1, 2, 3 …
 *   HANGUL_SYLLABLE        가, 나, 다 …
 *   LATIN_SMALL            a, b, c …
 *   LATIN_LARGE            A, B, C …
 *   ROMAN_SMALL            i, ii, iii …
 *   ROMAN_LARGE            I, II, III …
 *   CIRCLED_DIGIT          ①, ②, ③ … ⑳
 *   CIRCLED_HANGUL_SYLLABLE ㉮, ㉯, ㉰ …
 *   CIRCLED_LATIN_SMALL    ⓐ, ⓑ, ⓒ …
 */

/**
 * Return bullet/numbering info for a paragraph, or null if the paragraph
 * has no list formatting.
 *
 * @param {object} p                  Parsed <hp:p> node
 * @param {object} numberingCounters  Mutable counter map { "numberId-level": n }
 * @param {Map}    paragraphProperties
 * @param {Map}    numberings
 * @param {Map}    bullets
 * @returns {{ text: string, indent: number, leftMargin: number } | null}
 */
export function getBulletInfo(p, numberingCounters, paragraphProperties, numberings, bullets) {
    const paraPrIDRef = p?.["@paraPrIDRef"];
    if (!paraPrIDRef) return null;

    const paraPr = paragraphProperties.get(String(paraPrIDRef));
    if (!paraPr) return null;

    const heading = paraPr.heading;
    if (!heading) return null;

    const indent = paraPr.indent ?? {};

    // ── BULLET type ───────────────────────────────────────────────────────────
    if (heading.type === "BULLET") {
        const char = bullets.get(String(heading.idRef)) ?? "•";
        // Empty char means the bullet is invisible (used for indentation only)
        if (!char) return null;
        return {
            text:       char,
            indent:     indent.intent ?? 0,
            leftMargin: indent.left   ?? 0,
        };
    }

    // ── NUMBER type ───────────────────────────────────────────────────────────
    if (heading.type !== "NUMBER") return null;

    const numberingId = String(heading.idRef);
    const level       = heading.level ?? 0;

    const numbering = numberings.get(numberingId);
    if (!numbering) return null;

    // paraHeads are stored in order; index 0 = level 1, index 1 = level 2, etc.
    const paraHead = numbering.paraHeads?.[level];
    if (!paraHead) return null;

    // Template like "^1.", "^3)", "(^5)", "^7"
    // The ^N placeholder is replaced with a formatted counter value.
    let text = paraHead.text ?? "";

    if (text.includes("^")) {
        const key = `${numberingId}-${level}`;
        if (!numberingCounters[key]) numberingCounters[key] = 1;

        const counter   = numberingCounters[key];
        const numFormat = paraHead.numFormat ?? "DIGIT";
        text = text.replace(/\^\d+/, formatCounter(counter, numFormat));

        numberingCounters[key]++;
    }

    return {
        text,
        indent:     indent.intent ?? 0,
        leftMargin: indent.left   ?? 0,
    };
}

// ─── Counter formatters ───────────────────────────────────────────────────────

/**
 * Convert an integer counter to the string representation required by numFormat.
 *
 * @param {number} n
 * @param {string} numFormat
 * @returns {string}
 */
export function formatCounter(n, numFormat) {
    switch (numFormat) {

        case "HANGUL_SYLLABLE": {
            // 가 나 다 라 마 바 사 아 자 차 카 타 파 하 (14 syllables, then wraps)
            const syllables = ["가","나","다","라","마","바","사","아","자","차","카","타","파","하"];
            return syllables[(n - 1) % syllables.length] ?? String(n);
        }

        case "LATIN_SMALL": {
            // a b c … z aa ab …
            return encodeAlpha(n, 97); // 97 = 'a'
        }

        case "LATIN_LARGE": {
            // A B C … Z AA AB …
            return encodeAlpha(n, 65); // 65 = 'A'
        }

        case "ROMAN_SMALL":
            return toRoman(n).toLowerCase();

        case "ROMAN_LARGE":
            return toRoman(n);

        case "CIRCLED_DIGIT": {
            // ①②③…⑳  (U+2460 … U+2473)
            if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
            return String(n);
        }

        case "CIRCLED_HANGUL_SYLLABLE": {
            // ㉮㉯㉰…  (U+326E … U+326F …)
            if (n >= 1 && n <= 14) return String.fromCharCode(0x326E + n - 1);
            return String(n);
        }

        case "CIRCLED_LATIN_SMALL": {
            // ⓐⓑⓒ…  (U+24D0 … U+24E9)
            if (n >= 1 && n <= 26) return String.fromCharCode(0x24D0 + n - 1);
            return String(n);
        }

        case "DIGIT":
        default:
            return String(n);
    }
}

// ─── Private ─────────────────────────────────────────────────────────────────

/** Encode n as base-26 alpha (a=1, z=26, aa=27, …). baseCode: 97=lower, 65=upper */
function encodeAlpha(n, baseCode) {
    let s = "";
    let x = n;
    while (x > 0) {
        s = String.fromCharCode(baseCode + ((x - 1) % 26)) + s;
        x = Math.floor((x - 1) / 26);
    }
    return s;
}

const ROMAN_VALS = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
const ROMAN_SYMS = ["M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"];

function toRoman(n) {
    let result = "";
    let x = n;
    for (let i = 0; i < ROMAN_VALS.length; i++) {
        while (x >= ROMAN_VALS[i]) { result += ROMAN_SYMS[i]; x -= ROMAN_VALS[i]; }
    }
    return result;
}
