/**
 * blockRenderer.js
 * Block-level HWPX node rendering.
 *
 * Block tags handled:
 *   hp:p          paragraph (bullet, numbering, indent, border, spacing)
 *   hp:tbl        table (with thead/tbody split for Pandoc)
 *   hp:tr         row (hidden row detection)
 *   hp:tc         cell (subList wrapper OR direct p fallback for older HWPX)
 *   hp:subList    cell content container
 *   hp:textbox    text box (mini-section)
 *   hp:frame      frame wrapper (may hold textbox or picture)
 *   hp:pic        block-level picture → <figure>
 *   hp:caption    caption below table/picture → <figcaption>
 *   hp:multiCol   multi-column section → render children sequentially
 *   hp:shapeObject / hp:chart / hp:ole / hp:equation  → typed placeholders
 *
 * Paragraph-level field processing:
 *   Scans all runs in a paragraph for fieldBegin(HYPERLINK)/fieldEnd pairs
 *   and wraps the contained runs in <a href="...">.
 *
 * Pandoc-friendly choices:
 *   Tables: <thead>/<tbody> split when tableHeaderFirstRow=true
 *   Captions: <figure><figcaption> wrapping
 *   Paragraph border: CSS border shorthand
 *   Hidden rows: skipped entirely
 */

import { renderRunToHtml, extractRunText } from "./inlineExtractor.js";

// ─── Public: render any node ──────────────────────────────────────────────────

export function renderNodeToHtml(node, flags, options, ctx) {
    if (!node) return "";

    // subList: mandatory cell-content wrapper — check BEFORE hp:p
    const subList = node?.["hp:subList"] ?? node?.subList;
    if (subList) {
        return toArray(subList)
            .map(sl => renderNodeToHtml(sl, flags, options, ctx))
            .join("");
    }

    // hp:p
    const ps = node?.["hp:p"] ?? node?.p;
    if (ps) {
        const counters = flags?.numberingCounters ?? {};
        return toArray(ps)
            .map(p => renderParagraph(p, flags, options, ctx, counters))
            .join("");
    }

    // hp:run
    const runs = node?.["hp:run"] ?? node?.run;
    if (runs) {
        const helpers = makeRunHelpers(ctx, flags, options);
        const runArr  = toArray(runs);
        // Process field pairs (hyperlinks) at this level
        return renderRunsWithFields(runArr, flags, options, helpers);
    }

    // hp:textbox — mini-section
    const textbox = node?.["hp:textbox"] ?? node?.textbox;
    if (textbox) {
        return toArray(textbox)
            .map(tb => renderNodeToHtml(tb, flags, options, ctx))
            .join("");
    }

    // hp:frame — may contain textbox or picture
    const frame = node?.["hp:frame"] ?? node?.frame;
    if (frame) {
        return toArray(frame)
            .map(f => renderNodeToHtml(f, flags, options, ctx))
            .join("");
    }

    // hp:pic at block level — wrap in <figure> if caption follows
    if (flags.enableImages) {
        const pic = node?.["hp:pic"] ?? node?.pic;
        if (pic) return renderBlockPic(toArray(pic), flags, options, ctx);
    }

    // hp:caption → <figcaption>
    const caption = node?.["hp:caption"] ?? node?.caption;
    if (caption) {
        const inner = renderNodeToHtml(Array.isArray(caption) ? caption[0] : caption, flags, options, ctx);
        return `<figcaption>${inner}</figcaption>`;
    }

    // hp:multiCol — render children sequentially (no column CSS for Pandoc compat)
    const multiCol = node?.["hp:multiCol"] ?? node?.multiCol;
    if (multiCol) {
        return toArray(multiCol)
            .map(mc => renderNodeToHtml(mc, flags, options, ctx))
            .join("");
    }

    // hp:equation — math placeholder
    const eq = node?.["hp:equation"] ?? node?.equation;
    if (eq) return `<span class="equation" data-type="equation">[equation]</span>`;

    // hp:shapeObject — vector shape placeholder
    const shape = node?.["hp:shapeObject"] ?? node?.shapeObject;
    if (shape) return `<span class="shape" data-type="shape"></span>`;

    // hp:chart — chart placeholder
    const chart = node?.["hp:chart"] ?? node?.chart;
    if (chart) return `<span class="chart" data-type="chart">[chart]</span>`;

    // hp:ole — OLE object placeholder
    const ole = node?.["hp:ole"] ?? node?.ole;
    if (ole) return `<span class="ole" data-type="ole">[embedded object]</span>`;

    // Direct text fallback
    if (typeof node === "string")              return ctx.escapeHtml(node);
    if (typeof node?.["#text"] === "string")   return ctx.escapeHtml(node["#text"]);

    return "";
}

// ─── Public: render table ─────────────────────────────────────────────────────

export function renderTableToHtml(tbl, flags, options, ctx) {
    const tableClass = options?.tableClassName ?? "hwpx-table";
    const trs        = tbl?.tr ?? tbl?.["hp:tr"];
    if (!trs) return `<table class="${tableClass}"></table>`;

    const rows = toArray(trs);

    // Collect row HTML, skipping hidden rows
    const headerRows = [];
    const bodyRows   = [];

    rows.forEach((tr, idx) => {
        // Skip rows flagged as hidden
        if (tr?.["@hidden"] === "1" || tr?.["@hidden"] === true) return;

        const tcs = tr?.tc ?? tr?.["hp:tc"];
        if (!tcs) {
            (idx === 0 && options?.tableHeaderFirstRow ? headerRows : bodyRows).push("<tr></tr>");
            return;
        }

        const cellHtml = toArray(tcs).map(tc => {
            // Cell content: standard path is hp:tc > hp:subList > hp:p
            // Fallback: some older HWPX files place hp:p directly inside hp:tc
            let inner;
            const subList = tc?.subList ?? tc?.["hp:subList"];
            if (subList) {
                inner = renderNodeToHtml(tc, flags, options, ctx);
            } else {
                // Direct hp:p inside hp:tc (older format fallback)
                const directPs = tc?.p ?? tc?.["hp:p"];
                if (directPs) {
                    const counters = flags?.numberingCounters ?? {};
                    inner = toArray(directPs)
                        .map(p => renderParagraph(p, flags, options, ctx, counters))
                        .join("");
                } else {
                    inner = "";
                }
            }

            // Span: lives in hp:cellSpan child element, NOT as direct tc attributes
            const cellSpan = tc?.cellSpan ?? tc?.["hp:cellSpan"];
            const colSpan  = cellSpan?.["@colSpan"] ?? cellSpan?.["@colspan"]
                          ?? tc?.["@colSpan"]        ?? tc?.["@colspan"]  ?? tc?.["@gridSpan"];
            const rowSpan  = cellSpan?.["@rowSpan"] ?? cellSpan?.["@rowspan"]
                          ?? tc?.["@rowSpan"]        ?? tc?.["@rowspan"];

            const sl         = Array.isArray(subList) ? subList[0] : subList;
            const alignStyle = getAlignStyle(sl) || getAlignStyle(tc);

            const attrs = [];
            if (colSpan && String(colSpan) !== "1") attrs.push(` colspan="${colSpan}"`);
            if (rowSpan && String(rowSpan) !== "1") attrs.push(` rowspan="${rowSpan}"`);

            // Per-cell borders from borderFill definition (respects NONE = invisible)
            const borderCss  = cellBorderStyle(tc, ctx?.borderFills);
            const cellStyles = [borderCss, alignStyle].filter(Boolean).join(";");
            if (cellStyles) attrs.push(` style="${cellStyles}"`);

            const isHeader = options?.tableHeaderFirstRow && idx === 0;
            const tag      = isHeader ? "th" : "td";
            return `<${tag}${attrs.join("")}>${inner}</${tag}>`;
        }).join("");

        const rowEl = `<tr>${cellHtml}</tr>`;
        if (options?.tableHeaderFirstRow && idx === 0) headerRows.push(rowEl);
        else bodyRows.push(rowEl);
    });

    // Build with thead/tbody for Pandoc — Pandoc converts <thead> to header row
    let tableBody = "";
    if (headerRows.length) {
        tableBody += `<thead>${headerRows.join("")}</thead>`;
    }
    if (bodyRows.length) {
        tableBody += `<tbody>${bodyRows.join("")}</tbody>`;
    }

    return `<table class="${tableClass}" style="border-collapse:collapse;border-spacing:0">${tableBody}</table>`;
}

// ─── Public: extract table plain text ────────────────────────────────────────

export function extractTableText(tbl) {
    const trs = tbl?.tr ?? tbl?.["hp:tr"];
    if (!trs) return "";

    return toArray(trs).filter(tr => tr?.["@hidden"] !== "1").map(tr => {
        const tcs = tr?.tc ?? tr?.["hp:tc"];
        if (!tcs) return "";

        return toArray(tcs).map(tc => {
            // subList path
            const subList = tc?.subList ?? tc?.["hp:subList"];
            const sls     = subList ? toArray(subList) : [];

            // Fallback: direct hp:p in tc
            const directPs = (!sls.length) ? (tc?.p ?? tc?.["hp:p"]) : null;

            if (sls.length) {
                return sls.map(sl => {
                    const ps = sl?.p ?? sl?.["hp:p"];
                    if (!ps) return "";
                    return toArray(ps).map(p => {
                        const runs = p?.run ?? p?.["hp:run"];
                        if (!runs) return "";
                        return toArray(runs)
                            .map(r => extractRunText(r, t => extractTableText(t)))
                            .join("");
                    }).filter(Boolean).join("\n");
                }).join("\n");
            } else if (directPs) {
                return toArray(directPs).map(p => {
                    const runs = p?.run ?? p?.["hp:run"];
                    if (!runs) return "";
                    return toArray(runs)
                        .map(r => extractRunText(r, t => extractTableText(t)))
                        .join("");
                }).join("\n");
            }
            return "";
        }).join("\t");
    }).join("\n");
}

// ─── Public: extract text from any node ──────────────────────────────────────

export function extractTextFromNode(node) {
    if (!node) return "";

    const subList = node?.["hp:subList"] ?? node?.subList;
    if (subList) return toArray(subList).map(sl => extractTextFromNode(sl)).join("\n");

    const textbox = node?.["hp:textbox"] ?? node?.textbox;
    if (textbox) return toArray(textbox).map(tb => extractTextFromNode(tb)).join("");

    const frame = node?.["hp:frame"] ?? node?.frame;
    if (frame) return toArray(frame).map(f => extractTextFromNode(f)).join("");

    const ps = node?.["hp:p"] ?? node?.p;
    if (ps) return toArray(ps).map(p => extractTextFromNode(p)).join("\n");

    const runs = node?.["hp:run"] ?? node?.run;
    if (runs) {
        return toArray(runs)
            .map(r => extractRunText(r, t => extractTableText(t)))
            .filter(Boolean).join("");
    }

    if (typeof node === "string")              return node;
    if (typeof node?.["#text"] === "string")   return node["#text"];
    return "";
}

// ─── Private: paragraph ──────────────────────────────────────────────────────

function renderParagraph(p, flags, options, ctx, counters) {
    const bulletInfo = ctx.getBulletInfo(p, counters);
    const helpers    = makeRunHelpers(ctx, flags, options);
    const runs       = p?.["hp:run"] ?? p?.run;
    let   inner      = "";

    if (runs) {
        // Process field pairs (hyperlinks) at run sequence level
        inner = renderRunsWithFields(toArray(runs), flags, options, helpers);
    }

    // Also handle nested block elements inside paragraph (textbox, frame, etc.)
    // These are rare but possible in some HWPX generators
    const textbox = p?.["hp:textbox"] ?? p?.textbox;
    if (textbox) inner += toArray(textbox).map(tb => renderNodeToHtml(tb, flags, options, ctx)).join("");

    const styles = [];

    // Text alignment
    const alignStyle = getAlignStyle(p);
    if (alignStyle) styles.push(alignStyle);

    // Left-margin indentation
    const paraPrIDRef = p?.["@paraPrIDRef"];
    const paraPr      = paraPrIDRef ? ctx.paragraphProperties.get(String(paraPrIDRef)) : undefined;
    const leftHwpUnit = paraPr?.indent?.left ?? (bulletInfo ? bulletInfo.leftMargin : 0);
    if (leftHwpUnit > 0) styles.push(`padding-left:${Math.round(leftHwpUnit / 100)}pt`);

    // Space before/after (margin-top/bottom from prev/next)
    if (paraPr?.indent?.prev > 0) styles.push(`margin-top:${Math.round(paraPr.indent.prev / 100)}pt`);
    if (paraPr?.indent?.next > 0) styles.push(`margin-bottom:${Math.round(paraPr.indent.next / 100)}pt`);

    // Paragraph border — only apply when the referenced borderFill has at least one
    // visible side. HWPX documents often write <hh:border borderFillIDRef="0"/> on
    // every paragraph as a structural placeholder; borderFillIDRef "0" (or any ID
    // whose fill has all sides NONE) must NOT produce a visible box.
    if (paraPr?.border && isBorderFillVisible(paraPr.border.borderFillIDRef, ctx.borderFills)) {
        styles.push("border:1px solid #888888");
        const { offsetLeft: ol = 0, offsetRight: or_ = 0,
                offsetTop: ot = 0, offsetBottom: ob = 0 } = paraPr.border;
        const pad = [ot, or_, ob, ol].map(v => `${Math.round(v / 100)}pt`).join(" ");
        styles.push(`padding:${pad}`);
    }

    const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
    const content   = bulletInfo ? `${bulletInfo.text} ${inner}` : inner;
    return `<p${styleAttr}>${content}</p>`;
}

// ─── Private: field pair processing ──────────────────────────────────────────

/**
 * Scan a sequence of runs for fieldBegin(HYPERLINK)/fieldEnd pairs.
 * Wraps the runs between the pair in <a href="url">.
 * Non-field runs are rendered normally.
 */
function renderRunsWithFields(runArr, flags, options, helpers) {
    const parts    = [];
    let   inField  = false;
    let   fieldUrl = null;
    let   fieldBuf = [];

    for (const run of runArr) {
        const ctrl = run?.ctrl ?? run?.["hp:ctrl"];
        let   hasFieldBegin = false;
        let   hasFieldEnd   = false;
        let   url           = null;

        if (ctrl) {
            for (const c of toArray(ctrl)) {
                const fb = c?.fieldBegin ?? c?.["hp:fieldBegin"];
                const fe = c?.fieldEnd   ?? c?.["hp:fieldEnd"];
                if (fb) {
                    const type = (fb?.["@type"] ?? "").toUpperCase();
                    if (type === "HYPERLINK") {
                        url = fb?.["@url"] ?? fb?.["@URL"] ?? null;
                        hasFieldBegin = true;
                    }
                }
                if (fe) hasFieldEnd = true;
            }
        }

        if (hasFieldBegin && url) {
            // Flush anything before the field
            if (fieldBuf.length) parts.push(fieldBuf.join(""));
            fieldBuf = [];
            inField  = true;
            fieldUrl = url;
            continue; // the begin-run itself has no visible text
        }

        if (hasFieldEnd && inField) {
            // Close the hyperlink
            const linkText = fieldBuf.join("") || fieldUrl;
            parts.push(`<a href="${escUrl(fieldUrl)}">${linkText}</a>`);
            fieldBuf = [];
            inField  = false;
            fieldUrl = null;
            continue;
        }

        const rendered = renderRunToHtml(run, flags, options, helpers);
        if (inField) fieldBuf.push(rendered);
        else         parts.push(rendered);
    }

    // Flush any unclosed field (malformed but handle gracefully)
    if (fieldBuf.length) {
        if (inField && fieldUrl) {
            parts.push(`<a href="${escUrl(fieldUrl)}">${fieldBuf.join("")}</a>`);
        } else {
            parts.push(fieldBuf.join(""));
        }
    }

    return parts.join("");
}

// ─── Private: block-level picture ────────────────────────────────────────────

function renderBlockPic(pics, flags, options, ctx) {
    const parts = [];
    for (const pic of pics) {
        const imgData = ctx.getBinaryData(pic);
        if (!imgData) continue;

        // Check for a sibling caption node
        const captionNode = pic?.caption ?? pic?.["hp:caption"];
        const capHtml     = captionNode
            ? `<figcaption>${renderNodeToHtml(captionNode, flags, options, ctx)}</figcaption>`
            : "";

        const imgTag = `<img src="data:${imgData.mimeType};base64,${imgData.base64}" alt="" style="max-width:100%;"/>`;
        parts.push(captionNode ? `<figure>${imgTag}${capHtml}</figure>` : imgTag);
    }
    return parts.join("");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRunHelpers(ctx, flags, options) {
    return {
        escapeHtml:        ctx.escapeHtml,
        renderTableToHtml: (tbl, f, o) => renderTableToHtml(tbl, f ?? flags, o ?? options, ctx),
        getBinaryData:     ctx.getBinaryData,
        getCharStyle:      ctx.getCharStyle,
    };
}

function getAlignStyle(node) {
    const a = node?.["@align"] ?? node?.["@textAlign"]
           ?? node?.paraPr?.["@align"] ?? node?.cellPr?.["@align"];
    if (typeof a !== "string") return "";
    const v = a.toLowerCase();
    return ["center","right","left","justify"].includes(v) ? `text-align:${v}` : "";
}

function escUrl(url) {
    try { return new URL(url).href; } catch { return url ?? "#"; }
}

function toArray(v) { return Array.isArray(v) ? v : [v]; }

/**
 * Returns true only when the borderFill referenced by borderFillId has at least
 * one side with a type other than "NONE".  A missing fill, or a fill where every
 * side is NONE (the default placeholder), is treated as invisible.
 */
function isBorderFillVisible(borderFillId, borderFills) {
    if (borderFillId == null || !borderFills) return false;
    const bf = borderFills.get(String(borderFillId));
    if (!bf) return false;
    return [bf.left, bf.right, bf.top, bf.bottom]
        .some(side => side?.type && side.type !== "NONE");
}

// ─── Border helpers ───────────────────────────────────────────────────────────

/**
 * Build a CSS border value for one side from a borderFill side definition.
 * { type, width, color }
 * type "NONE" or missing → "none"
 */
function singleBorderCss(b) {
    if (!b || !b.type || b.type === "NONE") return "none";
    let px = 1;
    if (b.width) {
        const mm = parseFloat(b.width);
        if (!isNaN(mm)) px = Math.max(1, Math.round(mm * 3.78));
    }
    const style = b.type === "DASHED" ? "dashed"
                : b.type === "DOTTED" ? "dotted"
                : b.type === "DOUBLE" ? "double"
                : "solid";
    return `${px}px ${style} ${b.color ?? "#000000"}`;
}

/**
 * Build complete inline CSS for a table cell based on its @borderFillIDRef.
 * Returns "" if no borderFill found (caller should then use no border).
 */
export function cellBorderStyle(tc, borderFills) {
    const bfId = tc?.["@borderFillIDRef"];
    if (!bfId || !borderFills) return "";
    const bf = borderFills.get(String(bfId));
    if (!bf) return "";

    const parts = [
        `border-left:${singleBorderCss(bf.left)}`,
        `border-right:${singleBorderCss(bf.right)}`,
        `border-top:${singleBorderCss(bf.top)}`,
        `border-bottom:${singleBorderCss(bf.bottom)}`,
    ];
    if (bf.fillColor && bf.fillColor !== "none") {
        parts.push(`background-color:${bf.fillColor}`);
    }
    return parts.join(";");
}