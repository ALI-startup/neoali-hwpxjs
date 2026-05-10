/**
 * headerParser.js
 * Parses Contents/header.xml into five Maps used during rendering.
 *
 * Maps produced:
 *   characterProperties  id -> ProcessedCharPr
 *   paragraphProperties  id -> ProcessedParaPr
 *   numberings           id -> { paraHeads[] }
 *   bullets              id -> char
 *   fontFaces            id -> raw node
 *
 * ProcessedCharPr shape:
 *   height, textColor, shadeColor,
 *   bold, italic,
 *   supscript  <- <hh:supscript/> present (real tag name in HWPX)
 *   subscript  <- derived from vertical offset heuristic
 *   strikeout  <- strikeout.shape !== "NONE"
 *   underline  <- underline.type  !== "NONE"
 *   underlineColor
 *   outline    <- outline.type !== "NONE"
 *   highlight  <- null here; populated from markpenBegin at run level
 *   raw
 *
 * ProcessedParaPr shape:
 *   indent: { left, right, intent, prev, next }
 *   heading: { type, idRef, level }
 *   border: { borderFillIDRef, offsetLeft, offsetRight, offsetTop, offsetBottom } | null
 *   lineSpacing: { type, value } | null
 */

export function parseStyleDefinitions(
    headerXml, characterProperties, paragraphProperties,
    numberings, bullets, fontFaces,
) {
    characterProperties.clear();
    paragraphProperties.clear();
    numberings.clear();
    bullets.clear();
    fontFaces.clear();

    const root    = headerXml?.head ?? headerXml;
    const refList = root?.refList;
    if (!root || !refList) return;

    parseFontFaces(refList, fontFaces);

    // Collect raw charPr nodes before processing (needed for inheritance)
    const rawCharPrs = new Map();
    parseRawCharPrs(refList, rawCharPrs);

    // Named styles for cascade resolution
    const stylesMap = parseStyles(root);

    // Process charPrs with inheritance
    rawCharPrs.forEach((raw, id) => {
        characterProperties.set(id, processCharPr(raw, rawCharPrs, stylesMap, 0));
    });

    parseNumberings(refList, numberings);
    parseBullets(refList, bullets);
    parseParaProperties(refList, paragraphProperties);
}

// --- Font faces ---------------------------------------------------------------

function parseFontFaces(refList, fontFaces) {
    const nodes = refList?.fontfaces?.fontface;
    if (!nodes) return;
    for (const f of toArray(nodes)) {
        const id = f?.["@id"];
        if (id !== undefined) fontFaces.set(String(id), f);
    }
}

// --- Named styles (inheritance) -----------------------------------------------

function parseStyles(root) {
    const map = new Map();
    const nodes = root?.refList?.styles?.style ?? root?.styles?.style;
    if (!nodes) return map;
    for (const s of toArray(nodes)) {
        const id = s?.["@id"];
        if (id !== undefined) {
            map.set(String(id), {
                charPrIDRef: s?.["@charPrIDRef"],
                paraPrIDRef: s?.["@paraPrIDRef"],
                name:        s?.["@name"] ?? "",
            });
        }
    }
    return map;
}

// --- Raw charPr ---------------------------------------------------------------

function parseRawCharPrs(refList, rawCharPrs) {
    const nodes = refList?.charProperties?.charPr;
    if (!nodes) return;
    for (const c of toArray(nodes)) {
        const id = c?.["@id"];
        if (id !== undefined) rawCharPrs.set(String(id), c);
    }
}

// --- ProcessedCharPr ----------------------------------------------------------

function processCharPr(raw, rawCharPrs, stylesMap, depth) {
    // Guard against circular style references
    if (depth > 5) return buildCharPr(raw, {});

    // Resolve named-style base first (cascade: base <- specific)
    let base = {};
    const styleIDRef = raw?.["@styleIDRef"];
    if (styleIDRef !== undefined) {
        const style     = stylesMap.get(String(styleIDRef));
        const baseID    = style?.charPrIDRef;
        const baseRaw   = baseID !== undefined ? rawCharPrs.get(String(baseID)) : undefined;
        if (baseRaw) base = processCharPr(baseRaw, rawCharPrs, stylesMap, depth + 1);
    }

    return buildCharPr(raw, base);
}

function buildCharPr(raw, base) {
    // --- strikeout: only recognised line-through shapes count as active ---
    // HWPX documents often write shape="3D" (a legacy HWP shadow placeholder)
    // on the default charPr for every character style even when no strikeout
    // is applied.  Checking "not NONE" therefore incorrectly marks all text as
    // struck-through.  We whitelist the shapes that genuinely mean "draw a
    // line through the text"; anything else (including "3D", "NONE", etc.) is
    // treated as no strikeout.
    const STRIKEOUT_ACTIVE = new Set(["SOLID", "DASHED", "DOTTED", "DOUBLE", "THICK_SOLID", "WAVE"]);
    const soNode   = raw?.strikeout;
    const strikeout = soNode !== undefined
        ? STRIKEOUT_ACTIVE.has(soNode?.["@shape"] ?? "")
        : (base.strikeout ?? false);

    // --- underline: type "NONE" = no underline ---
    const ulNode       = raw?.underline;
    const ulType       = ulNode?.["@type"] ?? "NONE";
    const underline    = ulNode !== undefined ? ulType !== "NONE" : (base.underline ?? false);
    const underlineColor = ulNode?.["@color"] ?? base.underlineColor ?? null;

    // --- outline: type "NONE" = no outline ---
    const olNode  = raw?.outline;
    const outline = olNode !== undefined
        ? (olNode?.["@type"] ?? "NONE") !== "NONE"
        : (base.outline ?? false);

    // --- supscript: presence of <hh:supscript/> element ---
    // Real HWPX tag is "supscript" (NOT "superscript")
    const supscript = raw?.supscript !== undefined ? true : (base.supscript ?? false);

    // --- subscript heuristic: negative vertical offset on all scripts ---
    // HWPX does not have a dedicated subscript element in common versions.
    // Some generators use a negative @relSz or negative offset. We keep base value.
    const subscript = base.subscript ?? false;

    return {
        height:         raw?.["@height"]     ?? base.height     ?? null,
        textColor:      raw?.["@textColor"]  ?? base.textColor  ?? null,
        shadeColor:     raw?.["@shadeColor"] ?? base.shadeColor ?? null,
        bold:           raw?.bold   !== undefined ? true : (base.bold   ?? false),
        italic:         raw?.italic !== undefined ? true : (base.italic ?? false),
        supscript,
        subscript,
        strikeout,
        underline,
        underlineColor,
        outline,
        highlight: base.highlight ?? null, // populated at run level from markpenBegin
        raw,
    };
}

// --- Numberings ---------------------------------------------------------------

function parseNumberings(refList, numberings) {
    const nodes = refList?.numberings?.numbering;
    if (!nodes) return;
    for (const n of toArray(nodes)) {
        const id = n?.["@id"];
        if (id !== undefined) numberings.set(String(id), processNumbering(n));
    }
}

function processNumbering(numbering) {
    const heads = numbering?.paraHead;
    if (!heads) return { paraHeads: [] };
    return {
        paraHeads: toArray(heads).map(h => ({
            level:     parseInt(h?.["@level"] ?? "0", 10),
            text:      typeof h === "string" ? h : (h?.["#text"] ?? h?.text ?? ""),
            align:     h?.["@align"],
            numFormat: h?.["@numFormat"] ?? "DIGIT",
        })),
    };
}

// --- Bullets ------------------------------------------------------------------

function parseBullets(refList, bullets) {
    const nodes = refList?.bullets?.bullet;
    if (!nodes) return;
    for (const b of toArray(nodes)) {
        const id   = b?.["@id"];
        const char = b?.["@char"] ?? "";
        if (id !== undefined) bullets.set(String(id), char);
    }
}

// --- Paragraph properties -----------------------------------------------------

function parseParaProperties(refList, paragraphProperties) {
    const nodes = refList?.paraProperties?.paraPr;
    if (!nodes) return;
    for (const p of toArray(nodes)) {
        const id = p?.["@id"];
        if (id !== undefined) paragraphProperties.set(String(id), processParaPr(p));
    }
}

function processParaPr(paraPr) {
    // margin lives either directly under paraPr, or inside switch/case or switch/default
    let margin = paraPr?.margin;
    if (!margin && paraPr?.switch) {
        const sw = paraPr.switch;
        margin = sw?.case?.margin ?? sw?.default?.margin;
    }

    const indent = {};
    if (margin) {
        const get = key => margin?.[key]?.["@value"];
        if (get("left")   != null) indent.left   = parseInt(get("left"),   10);
        if (get("right")  != null) indent.right  = parseInt(get("right"),  10);
        if (get("intent") != null) indent.intent = parseInt(get("intent"), 10);
        if (get("prev")   != null) indent.prev   = parseInt(get("prev"),   10); // space before
        if (get("next")   != null) indent.next   = parseInt(get("next"),   10); // space after
    }

    // Line spacing
    let lineSpacing = null;
    const lsNode = paraPr?.lineSpacing;
    if (lsNode) {
        lineSpacing = {
            type:  lsNode?.["@type"] ?? "PERCENT",
            value: parseFloat(lsNode?.["@value"] ?? "160"),
        };
    }

    // Paragraph border (e.g. box around paragraph)
    let border = null;
    const bNode = paraPr?.border;
    if (bNode && bNode?.["@borderFillIDRef"]) {
        border = {
            borderFillIDRef: bNode["@borderFillIDRef"],
            offsetLeft:      parseInt(bNode?.["@offsetLeft"]   ?? "0", 10),
            offsetRight:     parseInt(bNode?.["@offsetRight"]  ?? "0", 10),
            offsetTop:       parseInt(bNode?.["@offsetTop"]    ?? "0", 10),
            offsetBottom:    parseInt(bNode?.["@offsetBottom"] ?? "0", 10),
        };
    }

    const result = { indent, lineSpacing, border };

    const heading = paraPr?.heading;
    if (heading) {
        result.heading = {
            type:  heading?.["@type"],
            idRef: heading?.["@idRef"],
            level: parseInt(heading?.["@level"] ?? "0", 10),
        };
    }

    return result;
}

// --- Utility -----------------------------------------------------------------

function toArray(v) { return Array.isArray(v) ? v : [v]; }

// ─── Border fills ─────────────────────────────────────────────────────────────

/**
 * Parse all <hh:borderFill> definitions into a Map.
 * Called separately so hwpxReader can pass in the borderFills map.
 *
 * borderFill shape:
 *   { left, right, top, bottom }  each: { type, width, color }
 *     type: "NONE" | "SOLID" | "DASHED" | "DOTTED" | "DOUBLE" | ...
 *   fillColor: "#RRGGBB" | "none"
 */
export function parseBorderFills(headerXml, borderFills) {
    borderFills.clear();
    const root    = headerXml?.head ?? headerXml;
    const refList = root?.refList;
    if (!refList) return;

    const nodes = refList?.borderFills?.borderFill;
    if (!nodes) return;

    for (const bf of toArray(nodes)) {
        const id = bf?.["@id"];
        if (id === undefined) continue;

        const get = (tag) => {
            const n = bf?.[tag];
            if (!n) return { type: "NONE", width: "0.1mm", color: "#000000" };
            return {
                type:  n?.["@type"]  ?? "NONE",
                width: n?.["@width"] ?? "0.1mm",
                color: n?.["@color"] ?? "#000000",
            };
        };

        // Fill color lives in <hh:fillBrush> or <hh:winBrush> or <hh:fill>
        const fillBrush = bf?.fillBrush ?? bf?.winBrush ?? bf?.fill;
        let fillColor = "none";
        if (fillBrush) {
            fillColor = fillBrush?.["@faceColor"]
                     ?? fillBrush?.fillColorPattern?.["@foreColor"]
                     ?? "none";
            // Filter fully transparent / white fills treated as transparent
            if (fillColor === "#FFFFFF" || fillColor === "none" || fillColor === "") {
                fillColor = "none";
            }
        }

        borderFills.set(String(id), {
            left:      get("leftBorder"),
            right:     get("rightBorder"),
            top:       get("topBorder"),
            bottom:    get("bottomBorder"),
            fillColor,
        });
    }
}