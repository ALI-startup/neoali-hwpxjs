/**
 * inlineExtractor.js
 * Every tag that can appear inside <hp:run>, plus ctrl-level field handling.
 *
 * Tags handled:
 *   hp:t           text content
 *   hp:s           spaces (@cnt)
 *   hp:lineBreak   hard line break
 *   hp:tab         tab character
 *   hp:nbSpace     non-breaking space
 *   hp:hyphen      soft hyphen
 *   hp:tbl         table embedded in run
 *   hp:picture / hp:drawObject / hp:img / hc:img   images
 *   hp:ctrl        control wrapper — inspected for field sub-tags:
 *     hp:fieldBegin  field start (HYPERLINK, MEMO, %pagenum, etc.)
 *     hp:fieldEnd    field end
 *     hp:pageNum     page number placeholder
 *     hp:autoNumFormat  auto-number (figure/table counter)
 *     hp:newNum      numbering restart
 *   hp:markpenBegin / hp:markpenEnd   text highlight
 *
 * Character decorations applied in applyCharStyle:
 *   bold -> <strong>, italic -> <em>
 *   supscript -> <sup>, subscript -> <sub>
 *   strikeout -> <s>, underline -> <u>
 *   outline -> CSS -webkit-text-stroke
 *   highlight (from markpenBegin) -> <mark>
 *   font-size, color, background-color -> inline CSS
 *
 * Pandoc-friendly output notes:
 *   <sup>, <sub>            -> pandoc superscript/subscript
 *   <s>                     -> ~~strikethrough~~
 *   <u>                     -> [text]{.underline}
 *   <mark style="...">      -> highlighted span
 *   <a href="url">          -> hyperlink
 *   <br/>                   -> line break
 */

// ─── Plain-text extraction ────────────────────────────────────────────────────

export function extractRunText(run, extractTableText) {
    if (!run) return "";
    if (isStructuralOnlyRun(run)) return "";

    const pieces = [];

    collectTextPieces(run?.t ?? run?.["hp:t"], pieces);
    collectSpacePieces(run?.s ?? run?.["hp:s"], pieces, false);
    if (hasTag(run, "lineBreak")) pieces.push("\n");
    if (hasTag(run, "tab"))       pieces.push("\t");
    if (hasTag(run, "nbSpace"))   pieces.push("\u00a0");
    if (hasTag(run, "hyphen"))    pieces.push("-");

    // ctrl may contain field/page-number sub-tags
    const ctrl = run?.ctrl ?? run?.["hp:ctrl"];
    if (ctrl) {
        for (const c of toArray(ctrl)) {
            const fieldBegin = c?.fieldBegin ?? c?.["hp:fieldBegin"];
            if (fieldBegin) {
                const type = fieldBegin?.["@type"] ?? "";
                // Skip page number and other layout field types
                if (type === "%pagenum" || type === "page_num" ||
                    type === "pagenum" || type === "%title" || type === "%author") continue;
            }
            const autoNum = c?.autoNumFormat ?? c?.["hp:autoNumFormat"];
            if (autoNum) {
                const suffix = autoNum?.["@suffixChar"] ?? ")";
                pieces.push(`[auto${suffix}]`);
            }
        }
    }

    // table embedded in run
    const tbl = run?.tbl ?? run?.["hp:tbl"];
    if (tbl && extractTableText) {
        for (const t of toArray(tbl)) pieces.push(extractTableText(t));
    }

    return pieces.join("");
}

// ─── HTML rendering ───────────────────────────────────────────────────────────

/**
 * Render a single <hp:run> to HTML.
 *
 * helpers: {
 *   escapeHtml, renderTableToHtml, getBinaryData, getCharStyle,
 *   footnoteRef(runNode) -> HTML string | null
 * }
 */
export function renderRunToHtml(run, flags, options, helpers) {
    if (!run) return "";
    if (isStructuralOnlyRun(run)) return "";

    let html = "";

    // ── hp:t ──────────────────────────────────────────────────────────────────
    const textPieces = [];
    collectTextPieces(run?.t ?? run?.["hp:t"], textPieces);
    if (textPieces.length) html += textPieces.map(t => helpers.escapeHtml(t)).join("");

    // ── hp:s ──────────────────────────────────────────────────────────────────
    const spacePieces = [];
    collectSpacePieces(run?.s ?? run?.["hp:s"], spacePieces, true);
    html += spacePieces.join("");

    // ── hp:lineBreak ──────────────────────────────────────────────────────────
    if (hasTag(run, "lineBreak")) html += "<br/>";

    // ── hp:tab ────────────────────────────────────────────────────────────────
    // Render as em-spaces; actual tab-stop widths would need layout info
    if (hasTag(run, "tab")) html += "\u2003\u2003"; // two em-spaces

    // ── hp:nbSpace ────────────────────────────────────────────────────────────
    if (hasTag(run, "nbSpace")) html += "&nbsp;";

    // ── hp:hyphen ─────────────────────────────────────────────────────────────
    if (hasTag(run, "hyphen")) html += "-";

    // ── hp:ctrl ───────────────────────────────────────────────────────────────
    // ctrl wraps field control characters. We inspect each ctrl child.
    const ctrl = run?.ctrl ?? run?.["hp:ctrl"];
    if (ctrl) {
        for (const c of toArray(ctrl)) {
            html += renderCtrl(c, flags, helpers);
        }
    }

    // ── hp:markpenBegin ───────────────────────────────────────────────────────
    // Highlight: markpenBegin carries the highlight color, markpenEnd closes it.
    // Both can appear as run children. We check for the Begin here to get the color.
    const mpBegin = run?.markpenBegin ?? run?.["hp:markpenBegin"];
    const mpEnd   = run?.markpenEnd   ?? run?.["hp:markpenEnd"];
    let highlightColor = null;
    if (mpBegin) {
        highlightColor = mpBegin?.["@color"] ?? null;
        // Filter out white (no-op highlight)
        if (highlightColor === "#FFFFFF" || highlightColor === "none") highlightColor = null;
    }

    // ── Images ────────────────────────────────────────────────────────────────
    if (flags.enableImages) {
        const imgData = helpers.getBinaryData(run);
        if (imgData) {
            html += `<img src="data:${imgData.mimeType};base64,${imgData.base64}" alt="" style="max-width:100%;"/>`;
        }
    }

    // ── hp:tbl embedded in run ────────────────────────────────────────────────
    if (flags.enableTables !== false) {
        const tbl = run?.tbl ?? run?.["hp:tbl"];
        if (tbl) {
            for (const t of toArray(tbl)) {
                html += helpers.renderTableToHtml(t, flags, options);
            }
        }
    }

    // ── Wrap highlight ────────────────────────────────────────────────────────
    if (highlightColor && html) {
        html = `<mark style="background-color:${highlightColor}">${html}</mark>`;
    }

    // ── Character style (bold, italic, size, color, decoration) ──────────────
    if (flags.enableStyles && html) {
        const charPrIDRef = run?.["@charPrIDRef"];
        if (charPrIDRef) {
            const style = helpers.getCharStyle(charPrIDRef);
            if (style) html = applyCharStyle(html, style);
        }
    }

    return html;
}

// ─── ctrl handler ─────────────────────────────────────────────────────────────

function renderCtrl(c, flags, helpers) {
    if (!c || typeof c !== "object") return "";
    let out = "";

    // fieldBegin — may be HYPERLINK, MEMO, %pagenum, etc.
    const fb = c?.fieldBegin ?? c?.["hp:fieldBegin"];
    if (fb) {
        const type = (fb?.["@type"] ?? "").toUpperCase();
        const url  = fb?.["@url"] ?? fb?.["@URL"] ?? null;

        if (type === "HYPERLINK" && url) {
            // Hyperlink: we return a sentinel that blockRenderer uses to wrap runs
            // Store on the ctrl node for blockRenderer to detect
            c.__hyperlinkUrl = url;
        } else if (type === "%PAGENUM" || type === "PAGE_NUM" || type === "PAGENUM") {
            // Layout placeholder — skip silently in body text
        } else if (type === "%TITLE" || type === "TITLE") {
            // Skip field markers — actual text is in the run's hp:t
        } else if (type === "%AUTHOR" || type === "AUTHOR") {
            // Skip field markers — actual text is in the run's hp:t
        } else if (type === "MEMO") {
            // Inline annotation — skip the memo marker itself, preserve annotated text
        }
    }

    // autoNumFormat — figure/table auto-counter
    const autoNum = c?.autoNumFormat ?? c?.["hp:autoNumFormat"];
    if (autoNum) {
        const prefix = autoNum?.["@prefixChar"] ?? "";
        const suffix = autoNum?.["@suffixChar"] ?? ")";
        // Rendered as a CSS counter — use a generic placeholder for Pandoc
        out += `<span class="auto-num">${prefix}#${suffix}</span>`;
    }

    // hp:pageNum is a layout-only placeholder — skip in body rendering

    return out;
}

// ─── applyCharStyle ───────────────────────────────────────────────────────────

/**
 * Wrap html with character decoration tags.
 * Order (outer → inner): highlight, sup/sub, strikeout, underline, bold, italic, span
 *
 * Pandoc reads:
 *   <sup>  → superscript   <sub>  → subscript
 *   <s>    → strikethrough <u>    → underline
 *   <strong> → bold        <em>   → italic
 *   <span style="..."> → passthrough with class/style
 */
export function applyCharStyle(html, style) {
    const open  = [];
    const close = [];

    // Superscript / subscript — mutually exclusive, supscript takes priority
    if (style.supscript)  { open.push("<sup>");  close.unshift("</sup>"); }
    else if (style.subscript) { open.push("<sub>"); close.unshift("</sub>"); }

    // Strikethrough
    if (style.strikeout)  { open.push("<s>");    close.unshift("</s>"); }

    // Underline
    if (style.underline)  { open.push("<u>");    close.unshift("</u>"); }

    // Bold / italic
    if (style.bold)       { open.push("<strong>"); close.unshift("</strong>"); }
    if (style.italic)     { open.push("<em>");     close.unshift("</em>"); }

    // CSS styles (font-size, color, background)
    if (style.styles?.length) {
        open.push(`<span style="${style.styles.join(";")}">`);
        close.unshift("</span>");
    }

    if (!open.length) return html;
    return open.join("") + html + close.join("");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * A run has no visible content if it only carries structural metadata
 * (section props, ctrl with no readable sub-tags, etc.)
 */
function isStructuralOnlyRun(run) {
    return !run?.tbl         && !run?.["hp:tbl"]
        && !run?.t           && !run?.["hp:t"]
        && !run?.s           && !run?.["hp:s"]
        && !run?.picture     && !run?.["hp:picture"]
        && !run?.drawObject  && !run?.["hp:drawObject"]
        && !run?.img         && !run?.["hp:img"]  && !run?.["hc:img"]
        && !run?.lineBreak   && !run?.["hp:lineBreak"]
        && !run?.tab         && !run?.["hp:tab"]
        && !run?.nbSpace     && !run?.["hp:nbSpace"]
        && !run?.hyphen      && !run?.["hp:hyphen"]
        && !run?.markpenBegin && !run?.["hp:markpenBegin"]
        && !hasCtrlWithContent(run);
}

function hasCtrlWithContent(run) {
    const ctrl = run?.ctrl ?? run?.["hp:ctrl"];
    if (!ctrl) return false;
    for (const c of toArray(ctrl)) {
        if (c?.fieldBegin || c?.["hp:fieldBegin"]) return true;
        // hp:pageNum alone is layout-only — does NOT count as content
        if (c?.autoNumFormat || c?.["hp:autoNumFormat"]) return true;
    }
    return false;
}

function collectTextPieces(t, out) {
    if (t == null) return;
    for (const item of toArray(t)) {
        if (typeof item === "string")              out.push(item);
        else if (typeof item?.["#text"] === "string") out.push(item["#text"]);
    }
}

function collectSpacePieces(s, out, nbsp) {
    if (s == null) return;
    const ch = nbsp ? "\u00a0" : " ";
    for (const elem of toArray(s)) {
        const cnt = typeof elem === "object" && elem?.["@cnt"]
            ? Math.max(1, parseInt(elem["@cnt"], 10) || 1) : 1;
        out.push(ch.repeat(cnt));
    }
}

/** True if a node has a property under key or "hp:key". */
function hasTag(node, key) {
    return (node?.[key] != null) || (node?.["hp:" + key] != null);
}

function toArray(v) { return Array.isArray(v) ? v : [v]; }
