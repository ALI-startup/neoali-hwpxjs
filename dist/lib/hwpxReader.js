/**
 * hwpxReader.js
 * Orchestrates all modules. Loads HWPX zip, populates style maps,
 * iterates sections, collects footnotes/endnotes, and emits
 * Pandoc-friendly HTML or plain text.
 *
 * File layout:
 *   encoding.js      UTF-8/16 auto-decode
 *   headerParser.js  style maps from header.xml
 *   bulletResolver.js bullet chars + numbered-list labels
 *   inlineExtractor.js run-level tags
 *   blockRenderer.js  paragraph, table, textbox, frame, caption…
 *   hwpxReader.js     ZIP load + section loop + public API  <-- here
 *
 * Pandoc footnote output format:
 *   Inline: <sup id="fnrefN"><a href="#fnN" role="doc-noteref">N</a></sup>
 *   Section at end:
 *     <section class="footnotes" role="doc-endnotes">
 *       <hr/>
 *       <ol>
 *         <li id="fnN" role="doc-endnote">
 *           <p>…text… <a href="#fnrefN" role="doc-backlink">↩</a></p>
 *         </li>
 *       </ol>
 *     </section>
 */

import { XMLParser }                                from "fast-xml-parser";
import JSZip                                        from "jszip";
import { HwpxEncryptedDocumentError,
         HwpxNotLoadedError }                       from "./errors.js";
import { decodeBytesSmart }                         from "./encoding.js";
import { parseStyleDefinitions,
         parseBorderFills }                         from "./headerParser.js";
import { getBulletInfo }                            from "./bulletResolver.js";
import { renderNodeToHtml,
         renderTableToHtml,
         extractTableText,
         extractTextFromNode }                      from "./blockRenderer.js";
import { extractRunText, applyCharStyle }           from "./inlineExtractor.js";

export class HwpxReader {

    // ── State ─────────────────────────────────────────────────────────────────
    zip  = null;
    files = {};
    encryptedCache = null;

    characterProperties = new Map();
    paragraphProperties = new Map();
    numberings          = new Map();
    bullets             = new Map();
    fontFaces           = new Map();
    borderFills         = new Map(); // id -> { left, right, top, bottom, fillColor }

    // ── Loading ───────────────────────────────────────────────────────────────

    async loadFromArrayBuffer(buffer) {
        const zip = await JSZip.loadAsync(buffer);
        this.zip   = zip;
        this.files = {};
        this.encryptedCache = null;
        this.borderFills.clear();

        await Promise.all(Object.keys(zip.files).map(async name => {
            const file = zip.file(name);
            if (file) this.files[name] = new Uint8Array(await file.async("uint8array"));
        }));

        const headerXml = this.getTextFile("Contents/header.xml");
        if (headerXml) {
            const parsed = this.parseXml(headerXml);
            if (parsed) {
                parseStyleDefinitions(
                    parsed,
                    this.characterProperties,
                    this.paragraphProperties,
                    this.numberings,
                    this.bullets,
                    this.fontFaces,
                );
                parseBorderFills(parsed, this.borderFills);
            }
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    async getDocumentInfo() {
        if (!this.zip) throw new HwpxNotLoadedError();
        return { metadata: this.readMetadata(), summary: this.summarizePackage() };
    }

    async extractText(options = {}) {
        if (!this.zip)               throw new HwpxNotLoadedError();
        if (this.detectEncryption()) throw new HwpxEncryptedDocumentError();

        const joiner       = options?.joinParagraphs ?? "\n";
        const sectionPaths = this.resolveSectionPaths();
        const paragraphs   = [];

        for (const path of sectionPaths) {
            const xmlText = this.getTextFile(path);
            if (!xmlText) continue;
            const xml     = this.parseXml(xmlText);
            const section = xml?.sec ?? xml?.section ?? xml?.["hp:section"];
            if (!section) {
                const segs = [];
                this.collectAllText(xml, segs);
                if (segs.length) paragraphs.push(segs.join(""));
                continue;
            }
            const ps = section?.p ?? section?.["hp:p"];
            if (!ps) {
                const segs = [];
                this.collectAllText(section, segs);
                if (segs.length) paragraphs.push(segs.join(""));
                continue;
            }
            for (const p of toArray(ps)) {
                const runs = p?.run ?? p?.["hp:run"];
                if (!runs) { paragraphs.push(""); continue; }
                paragraphs.push(
                    toArray(runs).map(r => extractRunText(r, t => extractTableText(t))).join("")
                );
            }
        }

        const combined = paragraphs.join(joiner);
        if (combined.trim()) return combined;

        const prvPath = this.findFilePathIgnoreCase("Preview/PrvText.txt");
        if (prvPath) {
            const prv = this.getTextFile(prvPath);
            if (prv?.trim()) return prv;
        }
        return combined;
    }

    async extractHtml(options = {}) {
        if (!this.zip)               throw new HwpxNotLoadedError();
        if (this.detectEncryption()) throw new HwpxEncryptedDocumentError();

        const paragraphTag      = options?.paragraphTag  ?? "p";
        const enableImages      = options?.renderImages  ?? true;
        const enableTables      = options?.renderTables  ?? true;
        const enableStyles      = options?.renderStyles  ?? true;
        const numberingCounters = {};

        // Footnote/endnote collector: { id, counter, html }[]
        const footnotes  = [];
        const endnotes   = [];
        let   fnCounter  = 0;
        let   enCounter  = 0;

        const ctx = this.makeRenderContext(numberingCounters, footnotes, endnotes,
                                           () => ++fnCounter, () => ++enCounter);
        const flags = { enableImages, enableStyles, enableTables, numberingCounters };

        const sectionPaths = this.resolveSectionPaths();
        const pieces = [];

        for (const path of sectionPaths) {
            const xmlText = this.getTextFile(path);
            if (!xmlText) continue;
            const xml     = this.parseXml(xmlText);
            const section = xml?.sec ?? xml?.section ?? xml?.["hp:section"];
            if (!section) continue;

            // Collect footnote/endnote content from this section
            this.collectNoteContent(section, footnotes, endnotes, flags, options, ctx);

            // Top-level paragraphs
            const ps = section?.p ?? section?.["hp:p"];
            if (ps) {
                for (const p of toArray(ps)) {
                    pieces.push(this.renderTopLevelParagraph(
                        p, paragraphTag, flags, options, ctx, numberingCounters
                    ));
                }
            }

            // Direct section-level tables (rare)
            const tbls = section?.tbl ?? section?.["hp:tbl"];
            if (tbls && enableTables) {
                for (const tbl of toArray(tbls)) {
                    // Check for sibling caption
                    pieces.push(this.renderTableWithCaption(tbl, flags, options, ctx));
                }
            }

            // Section-level pictures/frames at top level
            if (enableImages) {
                const pics = section?.pic ?? section?.["hp:pic"];
                if (pics) {
                    for (const pic of toArray(pics)) {
                        const imgData = ctx.getBinaryData(pic);
                        if (imgData) {
                            pieces.push(`<figure><img src="data:${imgData.mimeType};base64,${imgData.base64}" alt="" style="max-width:100%;"/></figure>`);
                        }
                    }
                }
            }
        }

        let html = pieces.join("");

        // Append Pandoc-compatible footnotes section
        if (footnotes.length) {
            html += buildFootnoteSection(footnotes, "footnotes", "fn");
        }
        if (endnotes.length) {
            html += buildFootnoteSection(endnotes, "endnotes", "en");
        }

        if (html.trim()) return html;

        // Fallback: preview text
        const prvPath = this.findFilePathIgnoreCase("Preview/PrvText.txt");
        if (prvPath) {
            const prv = this.getTextFile(prvPath);
            if (prv?.trim()) {
                html = `<p>${this.escapeHtml(prv).replace(/\n+/g, "</p><p>")}</p>`;
            }
        }
        return html;
    }

    applyTemplateToText(raw, data) {
        return raw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
            const val = key.split(".").reduce(
                (a, k) => (a && a[k] !== undefined ? a[k] : undefined), data
            );
            return val == null ? "" : String(val);
        });
    }

    async listImages() {
        if (!this.zip) throw new HwpxNotLoadedError();
        return Object.keys(this.files)
            .filter(p => p.startsWith("BinData/") && !p.endsWith("/"))
            .sort();
    }

    // ── Paragraph rendering ───────────────────────────────────────────────────

    renderTopLevelParagraph(p, paragraphTag, flags, options, ctx, numberingCounters) {
        const bulletInfo  = ctx.getBulletInfo(p, numberingCounters);
        const inner       = renderNodeToHtml(p, flags, options, ctx);
        const alignStyle  = getAlignStyle(p);
        const styles      = alignStyle ? [alignStyle] : [];

        const paraPrIDRef = p?.["@paraPrIDRef"];
        const paraPr      = paraPrIDRef ? this.paragraphProperties.get(String(paraPrIDRef)) : undefined;
        const leftHwpUnit = paraPr?.indent?.left ?? (bulletInfo ? bulletInfo.leftMargin : 0);
        if (leftHwpUnit > 0) styles.push(`padding-left:${Math.round(leftHwpUnit / 100)}pt`);

        if (paraPr?.indent?.prev > 0) styles.push(`margin-top:${Math.round(paraPr.indent.prev / 100)}pt`);
        if (paraPr?.indent?.next > 0) styles.push(`margin-bottom:${Math.round(paraPr.indent.next / 100)}pt`);

        // Only emit a visible border when the referenced borderFill has at least one
        // non-NONE side.  HWPX writes borderFillIDRef="0" on almost every paragraph
        // as a structural default; that fill has all sides NONE and must stay invisible.
        if (paraPr?.border) {
            const bf = this.borderFills.get(String(paraPr.border.borderFillIDRef));
            const hasBorder = bf && [bf.left, bf.right, bf.top, bf.bottom]
                .some(s => s?.type && s.type !== "NONE");
            if (hasBorder) styles.push("border:1px solid #888888");
        }

        const styleAttr = styles.length ? ` style="${styles.join(";")}"` : "";
        const content   = bulletInfo ? `${bulletInfo.text} ${inner}` : inner;
        return `<${paragraphTag}${styleAttr}>${content}</${paragraphTag}>`;
    }

    renderTableWithCaption(tbl, flags, options, ctx) {
        const captionNode = tbl?.caption ?? tbl?.["hp:caption"];
        const tableHtml   = renderTableToHtml(tbl, flags, options, ctx);
        if (!captionNode) return tableHtml;

        const capInner = renderNodeToHtml(
            Array.isArray(captionNode) ? captionNode[0] : captionNode,
            flags, options, ctx
        );
        // Pandoc wraps table+caption in <figure> when it sees this pattern
        return `<figure>${tableHtml}<figcaption>${capInner}</figcaption></figure>`;
    }

    // ── Footnote/endnote collection ───────────────────────────────────────────

    collectNoteContent(section, footnotes, endnotes, flags, options, ctx) {
        // Footnotes and endnotes can appear as children of the section
        const fnNodes = section?.footnote ?? section?.["hp:footnote"];
        if (fnNodes) {
            for (const fn of toArray(fnNodes)) {
                const id  = fn?.["@id"] ?? String(footnotes.length + 1);
                const html = renderNodeToHtml(fn, flags, options, ctx);
                footnotes.push({ id: String(id), html });
            }
        }
        const enNodes = section?.endnote ?? section?.["hp:endnote"];
        if (enNodes) {
            for (const en of toArray(enNodes)) {
                const id  = en?.["@id"] ?? String(endnotes.length + 1);
                const html = renderNodeToHtml(en, flags, options, ctx);
                endnotes.push({ id: String(id), html });
            }
        }
    }

    // ── Context builder ───────────────────────────────────────────────────────

    makeRenderContext(numberingCounters, footnotes, endnotes, nextFn, nextEn) {
        const self = this;
        // Pre-build context without circular renderTableToHtml dependency
        const ctx = {
            paragraphProperties: this.paragraphProperties,

            getBulletInfo: (p, counters) =>
                getBulletInfo(p, counters,
                    self.paragraphProperties, self.numberings, self.bullets),

            escapeHtml: text => self.escapeHtml(text),

            getBinaryData: run => self.getBinaryData(run),

            getCharStyle: charPrIDRef => self.getCharStyle(charPrIDRef),

            convertHwpUnitToPoints: u => self.convertHwpUnitToPoints(u),

            borderFills: self.borderFills,

            // Footnote inline reference generator
            footnoteRef: (run) => {
                const ctrl = run?.ctrl ?? run?.["hp:ctrl"];
                if (!ctrl) return null;
                for (const c of toArray(ctrl)) {
                    if (c?.footnoteNum ?? c?.["hp:footnoteNum"]) {
                        const n   = nextFn();
                        const ref = `<sup id="fnref${n}"><a href="#fn${n}" role="doc-noteref">${n}</a></sup>`;
                        return ref;
                    }
                    if (c?.endnoteNum ?? c?.["hp:endnoteNum"]) {
                        const n   = nextEn();
                        const ref = `<sup id="enref${n}"><a href="#en${n}" role="doc-noteref">${n}</a></sup>`;
                        return ref;
                    }
                }
                return null;
            },
        };

        // Circular: renderTableToHtml needs ctx, ctx needs renderTableToHtml
        ctx.renderTableToHtml = (tbl, f, o) =>
            renderTableToHtml(tbl, f, o, self.makeRenderContext(
                numberingCounters, footnotes, endnotes, nextFn, nextEn
            ));

        return ctx;
    }

    // ── Section path resolution ───────────────────────────────────────────────

    resolveSectionPaths() {
        const spine = this.getSectionPathsBySpine();
        if (spine?.length) return spine;

        let paths = Object.keys(this.files)
            .filter(p => /^contents\/section\d+\.xml$/i.test(p))
            .sort((a, b) => sectionNum(a) - sectionNum(b));
        if (paths.length) return paths;

        paths = [];
        for (const p of Object.keys(this.files).filter(p =>
            p.startsWith("Contents/") && p.endsWith(".xml"))
        ) {
            const xml = this.parseXml(this.getTextFile(p) ?? "");
            if (xml && (xml.sec || xml.section || xml["hp:section"])) paths.push(p);
        }
        return paths.sort((a, b) => sectionNum(a) - sectionNum(b));
    }

    getSectionPathsBySpine() {
        const raw = this.getTextFile("Contents/content.hpf");
        if (!raw) return null;
        const xml = this.parseXml(raw);
        const pkg = xml?.package ?? xml?.opf?.package;
        const man = pkg?.manifest?.item;
        if (!man) return null;

        const map = new Map();
        for (const it of toArray(man)) {
            const id   = it?.["@id"];
            const href = it?.["@href"];
            if (id && href && /Contents\/section\d+\.xml$/i.test(href)) map.set(id, href);
        }
        const sp   = pkg?.spine?.itemref ?? pkg?.spine?.itemRef;
        const refs = sp ? toArray(sp) : [];
        const out  = [];
        for (const r of refs) {
            const id   = r?.["@idref"] ?? r?.["@idRef"];
            const href = id ? map.get(id) : undefined;
            if (href && this.files[href]) out.push(href);
        }
        return out.length ? out : null;
    }

    // ── Character style ───────────────────────────────────────────────────────

    getCharStyle(charPrIDRef) {
        const charPr = this.characterProperties.get(String(charPrIDRef));
        if (!charPr) return null;

        const styles = [];
        if (charPr.height) {
            styles.push(`font-size:${this.convertHwpUnitToPoints(charPr.height)}pt`);
        }
        if (charPr.textColor && charPr.textColor !== "none" && charPr.textColor !== "#000000") {
            styles.push(`color:${normalizeColor(charPr.textColor)}`);
        }
        if (charPr.shadeColor && charPr.shadeColor !== "none") {
            styles.push(`background-color:${normalizeColor(charPr.shadeColor)}`);
        }
        if (charPr.outline) {
            styles.push("-webkit-text-stroke:1px currentColor");
        }

        const hasDecoration = charPr.bold || charPr.italic || charPr.supscript
            || charPr.subscript || charPr.strikeout || charPr.underline;
        if (!styles.length && !hasDecoration) return null;

        return {
            bold:       charPr.bold,
            italic:     charPr.italic,
            supscript:  charPr.supscript,
            subscript:  charPr.subscript,
            strikeout:  charPr.strikeout,
            underline:  charPr.underline,
            outline:    charPr.outline,
            styles,
        };
    }

    // ── Binary / image ────────────────────────────────────────────────────────

    getBinaryData(node) {
        if (!node) return null;
        const candidates = [
            node?.picture    ?? node?.["hp:picture"],
            node?.drawObject ?? node?.["hp:drawObject"],
            node?.img        ?? node?.["hp:img"],
            node?.["hc:img"],
            // Also check the node itself (block-level pic)
            node?.["@binaryItemIDRef"] ? node : null,
        ];
        for (const c of candidates) {
            if (!c) continue;
            const ref = c?.["@binaryItemIDRef"]
                     ?? c?.img?.["@binaryItemIDRef"]
                     ?? c?.["hp:binItem"]?.["@ref"]
                     ?? c?.binItem?.["@ref"]
                     ?? c?.["@ref"];
            if (!ref) continue;
            const path  = this.resolveBinaryPath(ref);
            const bytes = this.files[path];
            if (!bytes) continue;
            return { mimeType: detectMimeType(path), base64: toBase64(bytes) };
        }
        return null;
    }

    resolveBinaryPath(ref) {
        const direct = `BinData/${ref}`;
        if (this.files[direct]) return direct;
        try {
            const summary = this.summarizePackage();
            const item    = summary.manifest?.find(i => i.id === ref);
            if (item?.href) {
                const resolved = item.href.startsWith("BinData/") ? item.href : `BinData/${item.href}`;
                if (this.files[resolved])  return resolved;
                if (this.files[item.href]) return item.href;
            }
        } catch { /* ignore */ }
        return direct;
    }

    // ── Package / metadata ────────────────────────────────────────────────────

    summarizePackage() {
        const hasEncryptionInfo = this.detectEncryption();
        const contentsFiles     = Object.keys(this.files).filter(p => p.startsWith("Contents/")).sort();
        const contentHpf = this.getTextFile("Contents/content.hpf");
        let manifest, spine;
        if (contentHpf) {
            const xml = this.parseXml(contentHpf);
            const pkg = xml?.package ?? xml?.opf?.package;
            const man = pkg?.manifest?.item;
            if (man) {
                manifest = toArray(man).map(it => ({
                    id:        it?.["@id"],
                    href:      it?.["@href"],
                    mediaType: it?.["@media-type"] ?? it?.["@mediaType"],
                }));
            }
            const sp = pkg?.spine?.itemref ?? pkg?.spine?.itemRef;
            if (sp) spine = toArray(sp).map(r => r?.["@idref"] ?? r?.["@idRef"]).filter(Boolean);
        }
        return { hasEncryptionInfo, contentsFiles, manifest, spine };
    }

    readMetadata() {
        const md = {};
        const hpf = this.getTextFile("Contents/content.hpf");
        if (hpf) {
            const xml = this.parseXml(hpf);
            const m   = xml?.package?.metadata;
            if (m) {
                md.title   = m["dc:title"]        ?? m.title;
                md.creator = m["dc:creator"]      ?? m.creator;
                md.created = m["dcterms:created"] ?? m.created;
            }
        }
        const ver = this.parseXml(this.getTextFile("version.xml") ?? "");
        const v   = ver?.Version?.OWPMLVersion ?? ver?.version?.owpmlVersion;
        if (typeof v === "string") md.version = v;
        return md;
    }

    detectEncryption() {
        if (this.encryptedCache !== null) return this.encryptedCache;
        const xml = this.parseXml(this.getTextFile("META-INF/manifest.xml") ?? "");
        this.encryptedCache = xml ? this.containsEncryptionMarker(xml) : false;
        return this.encryptedCache;
    }

    containsEncryptionMarker(node) {
        if (!node) return false;
        if (typeof node === "string") return /encrypt|cipher/i.test(node);
        if (Array.isArray(node)) return node.some(n => this.containsEncryptionMarker(n));
        if (typeof node === "object") {
            for (const [k, v] of Object.entries(node)) {
                if (/encrypt|cipher/i.test(k)) return true;
                if (typeof v === "string" && /encrypt|cipher/i.test(v)) return true;
                if (this.containsEncryptionMarker(v)) return true;
            }
        }
        return false;
    }

    // ── XML / file helpers ────────────────────────────────────────────────────

    getTextFile(path) {
        const bytes = this.files[path];
        return bytes ? decodeBytesSmart(bytes) : null;
    }

    findFilePathIgnoreCase(p) {
        const l = p.toLowerCase();
        return Object.keys(this.files).find(k => k.toLowerCase() === l) ?? null;
    }

    parseXml(xml) {
        try {
            return new XMLParser({
                ignoreAttributes:    false,
                attributeNamePrefix: "@",
                trimValues:          false,
                removeNSPrefix:      true,
                preserveOrder:       false,
                parseTagValue:       false,
                parseAttributeValue: false,
            }).parse(xml);
        } catch { return null; }
    }

    // ── Utility ───────────────────────────────────────────────────────────────

    escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    convertHwpUnitToPoints(u) {
        const n = typeof u === "number" ? u : parseInt(String(u), 10);
        return Math.round((n / 100) * 10) / 10;
    }

    collectAllText(node, out) {
        if (!node) return;
        if (typeof node === "object" && (node.secPr || node.ctrl || node.linesegarray)) return;
        if (typeof node === "string") { out.push(node); return; }
        if (typeof node === "object") {
            if (typeof node["#text"] === "string") out.push(node["#text"]);
            if (typeof node.t === "string")        { out.push(node.t); return; }
            for (const [k, v] of Object.entries(node)) {
                if (k === "#text" || k === "t" || k === "secPr" || k === "ctrl" || k === "linesegarray") continue;
                this.collectAllText(v, out);
            }
        }
    }
}

export default HwpxReader;

// ─── Module-level helpers ─────────────────────────────────────────────────────

function toArray(v) { return Array.isArray(v) ? v : [v]; }

function sectionNum(path) {
    return Number(path.match(/section(\d+)\.xml/i)?.[1] ?? 0);
}

function getAlignStyle(node) {
    const a = node?.["@align"] ?? node?.["@textAlign"]
           ?? node?.paraPr?.["@align"] ?? node?.cellPr?.["@align"];
    if (typeof a !== "string") return "";
    const v = a.toLowerCase();
    return ["center","right","left","justify"].includes(v) ? `text-align:${v}` : "";
}

function normalizeColor(c) {
    const s = String(c).trim();
    return /^#?[0-9a-fA-F]{6}$/.test(s) ? (s.startsWith("#") ? s : `#${s}`) : s;
}

function detectMimeType(path) {
    const l = path.toLowerCase();
    if (l.endsWith(".png"))                    return "image/png";
    if (l.endsWith(".jpg") || l.endsWith(".jpeg")) return "image/jpeg";
    if (l.endsWith(".gif"))                    return "image/gif";
    if (l.endsWith(".bmp"))                    return "image/bmp";
    if (l.endsWith(".webp"))                   return "image/webp";
    return "application/octet-stream";
}

function toBase64(bytes) {
    if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
    let b = "";
    for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i]);
    return btoa(b); // eslint-disable-line no-undef
}

/** Build a Pandoc-compatible footnote/endnote section at bottom of HTML. */
function buildFootnoteSection(notes, className, prefix) {
    const items = notes.map((n, i) => {
        const num = i + 1;
        const backlink = `<a href="#${prefix}ref${num}" role="doc-backlink">&#8617;</a>`;
        return `<li id="${prefix}${num}" role="doc-endnote"><p>${n.html} ${backlink}</p></li>`;
    });
    return [
        `<section class="${className}" role="doc-endnotes">`,
        `<hr/>`,
        `<ol>`,
        ...items,
        `</ol>`,
        `</section>`,
    ].join("");
}