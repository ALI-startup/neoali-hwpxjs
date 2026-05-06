import { XMLParser } from "fast-xml-parser";
import JSZip from "jszip";
import { HwpxEncryptedDocumentError, HwpxNotLoadedError } from "./errors.js";
const DECODER_UTF8 = new TextDecoder("utf-8");
const DECODER_UTF16LE = new TextDecoder("utf-16le");
const DECODER_UTF16BE = new TextDecoder("utf-16be");
function detectTextEncoding(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
        return "utf-8";
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
        return "utf-16le";
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
        return "utf-16be";
    // Heuristic: many zeros on odd/even positions → UTF-16
    let zeroEven = 0, zeroOdd = 0, sample = Math.min(bytes.length, 1024);
    for (let i = 0; i < sample; i++) {
        if (bytes[i] === 0)
            (i % 2 === 0 ? zeroEven++ : zeroOdd++);
    }
    if (zeroOdd > zeroEven * 2)
        return "utf-16le"; // LE: xx 00 xx 00
    if (zeroEven > zeroOdd * 2)
        return "utf-16be"; // BE: 00 xx 00 xx
    return "utf-8";
}
function decodeBytesSmart(bytes) {
    const enc = detectTextEncoding(bytes);
    // Strip BOM
    if (enc === "utf-8" && bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return DECODER_UTF8.decode(bytes.subarray(3));
    }
    if (enc === "utf-16le" && bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        return DECODER_UTF16LE.decode(bytes.subarray(2));
    }
    if (enc === "utf-16be" && bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        return DECODER_UTF16BE.decode(bytes.subarray(2));
    }
    if (enc === "utf-8")
        return DECODER_UTF8.decode(bytes);
    if (enc === "utf-16le")
        return DECODER_UTF16LE.decode(bytes);
    return DECODER_UTF16BE.decode(bytes);
}
function getOrEmpty(value) {
    return value ?? undefined;
}
export class HwpxReader {
    zip = null;
    files = {};
    encryptedCache = null;
    characterProperties = new Map();
    fontFaces = new Map();
    // NEW: Add maps for paragraph properties and numberings
    paragraphProperties = new Map();
    numberings = new Map();
    bullets = new Map(); // hh:bullet definitions: id → char
    
    async loadFromArrayBuffer(buffer) {
        const zip = await JSZip.loadAsync(buffer);
        this.zip = zip;
        this.files = {};
        const entries = Object.keys(zip.files);
        await Promise.all(entries.map(async (name) => {
            const file = zip.file(name);
            if (!file)
                return;
            // store raw bytes for flexible processing (images, xml, etc.)
            this.files[name] = new Uint8Array(await file.async("uint8array"));
        }));
        // Validate mimetype (per spec: application/owpml). 다양한 변형을 수용하고, 불일치 시에도 진행.
        const mime = this.getTextFile("mimetype")?.trim();
        if (mime && !this.isLikelyHwpxMime(mime)) {
            // 엄격 차단 대신 경고성 에러로 유지하려면 throw를 피한다.
            // throw new InvalidHwpxFormatError();
        }
        // Try to locate content via META-INF/container.xml if present (not mandatory but helpful)
        const containerXml = this.getTextFile("META-INF/container.xml");
        if (containerXml) {
            const cx = this.parseXml(containerXml);
            // not strictly necessary now; reserved for future rootfile discovery
            void cx;
        }
        // Parse styles from header.xml
        this.parseStyleDefinitions();
    }
    isLikelyHwpxMime(m) {
        const s = m.toLowerCase();
        // 허용: application/owpml, application/owpml+xml, application/vnd.hancom.hwpx(추정), hwpx/owpml 포함 케이스
        return s === "application/owpml" || s.includes("owpml") || s.includes("hwpx");
    }
    getTextFile(path) {
        const bytes = this.files[path];
        if (!bytes)
            return null;
        return decodeBytesSmart(bytes);
    }
    findFilePathIgnoreCase(targetPath) {
        const lower = targetPath.toLowerCase();
        for (const key of Object.keys(this.files)) {
            if (key.toLowerCase() === lower)
                return key;
        }
        return null;
    }
    parseXml(xml) {
        try {
            const parser = new XMLParser({
                ignoreAttributes: false,
                attributeNamePrefix: "@",
                trimValues: false,  // CHANGED: Don't trim to preserve spaces
                removeNSPrefix: true,
                preserveOrder: false,
                parseTagValue: false,
                parseAttributeValue: false,
            });
            const obj = parser.parse(xml);
            return obj;
        }
        catch (_err) {
            return null;
        }
    }
    summarizePackage() {
        const hasEncryptionInfo = this.detectEncryption();
        const contentsFiles = Object.keys(this.files).filter((p) => p.startsWith("Contents/")).sort();
        const contentHpf = this.getTextFile("Contents/content.hpf");
        let manifest;
        let spine;
        if (contentHpf) {
            const xml = this.parseXml(contentHpf);
            const pkg = xml?.package ?? xml?.opf?.package;
            const man = pkg?.manifest?.item;
            if (man) {
                const items = Array.isArray(man) ? man : [man];
                manifest = items.map((it) => ({
                    id: it?.["@id"],
                    href: it?.["@href"],
                    mediaType: it?.["@media-type"] ?? it?.["@mediaType"],
                }));
            }
            const sp = pkg?.spine?.itemref ?? pkg?.spine?.itemRef;
            if (sp) {
                const refs = Array.isArray(sp) ? sp : [sp];
                spine = refs.map((r) => r?.["@idref"] ?? r?.["@idRef"]).filter(Boolean);
            }
        }
        return { hasEncryptionInfo, contentsFiles, manifest, spine };
    }
    getSectionPathsBySpine() {
        const contentHpf = this.getTextFile("Contents/content.hpf");
        if (!contentHpf)
            return null;
        const xml = this.parseXml(contentHpf);
        const pkg = xml?.package ?? xml?.opf?.package;
        const man = pkg?.manifest?.item;
        const map = new Map(); // id -> href
        if (man) {
            const items = Array.isArray(man) ? man : [man];
            for (const it of items) {
                const id = it?.["@id"];
                const href = it?.["@href"];
                if (id && href && /Contents\/section\d+\.xml$/i.test(href))
                    map.set(id, href);
            }
        }
        const sp = pkg?.spine?.itemref ?? pkg?.spine?.itemRef;
        const refs = sp ? (Array.isArray(sp) ? sp : [sp]) : [];
        const paths = [];
        for (const r of refs) {
            const id = r?.["@idref"] ?? r?.["@idRef"];
            const href = id ? map.get(id) : undefined;
            if (href && this.files[href])
                paths.push(href);
        }
        return paths.length ? paths : null;
    }
    detectEncryption() {
        if (this.encryptedCache !== null)
            return this.encryptedCache;
        const manifestXml = this.getTextFile("META-INF/manifest.xml");
        if (!manifestXml) {
            this.encryptedCache = false;
            return false;
        }
        const obj = this.parseXml(manifestXml);
        const has = this.containsEncryptionMarker(obj);
        this.encryptedCache = !!has;
        return this.encryptedCache;
    }
    containsEncryptionMarker(node) {
        if (!node)
            return false;
        if (typeof node === "string") {
            return /encrypt|cipher/i.test(node);
        }
        if (Array.isArray(node)) {
            for (const item of node) {
                if (this.containsEncryptionMarker(item))
                    return true;
            }
            return false;
        }
        if (typeof node === "object") {
            for (const [k, v] of Object.entries(node)) {
                if (/encrypt|cipher/i.test(k))
                    return true;
                if (typeof v === "string" && /encrypt|cipher/i.test(v))
                    return true;
                if (this.containsEncryptionMarker(v))
                    return true;
            }
        }
        return false;
    }
    readMetadata() {
        const contentHpf = this.getTextFile("Contents/content.hpf");
        const metadata = {};
        if (contentHpf) {
            const xml = this.parseXml(contentHpf);
            // OPF-like: package > metadata
            const md = xml?.package?.metadata;
            if (md) {
                metadata.title = getOrEmpty(md["dc:title"] ?? md.title);
                metadata.creator = getOrEmpty(md["dc:creator"] ?? md.creator);
                metadata.created = getOrEmpty(md["dcterms:created"] ?? md.created);
                metadata.modified = getOrEmpty(md["dcterms:modified"] ?? md.modified);
            }
        }
        const versionXml = this.getTextFile("version.xml");
        if (versionXml) {
            const v = this.parseXml(versionXml);
            const ver = v?.Version?.OWPMLVersion ?? v?.version?.owpmlVersion;
            if (typeof ver === "string") {
                metadata.version = ver;
            }
        }
        const settingsXml = this.getTextFile("settings.xml");
        if (settingsXml) {
            const s = this.parseXml(settingsXml);
            // 표준 예시: ha:HWPApplicationSetting > ha:CaretPosition(listIDRef, paraIDRef, pos)
            const app = s?.HWPApplicationSetting ?? s?.Settings ?? s?.settings;
            const caret = app?.CaretPosition ?? app?.caretPosition;
            if (caret && (caret["@listIDRef"] || caret["@paraIDRef"] || caret["@pos"])) {
                const listId = caret["@listIDRef"] ?? "0";
                const paraId = caret["@paraIDRef"] ?? "0";
                const pos = caret["@pos"] ?? "0";
                metadata.caretPosition = `${listId}:${paraId}:${pos}`;
            }
        }
        return metadata;
    }
    async getDocumentInfo() {
        if (!this.zip)
            throw new HwpxNotLoadedError();
        const summary = this.summarizePackage();
        const metadata = this.readMetadata();
        return { metadata, summary };
    }
    
    // NEW: Extract text/spaces from a run element
    extractRunText(run) {
        if (!run) return "";
        // Skip runs that are purely section-property or ctrl containers with no content
        if (run?.secPr && !run?.tbl && !run?.t && !run?.s) return "";
        if (run?.ctrl && !run?.tbl && !run?.t && !run?.s) return "";
        
        const pieces = [];
        
        // Handle text elements - can be single or array
        const t = run?.t ?? run?.["hp:t"];
        if (t !== undefined && t !== null) {
            if (Array.isArray(t)) {
                for (const item of t) {
                    if (typeof item === "string") {
                        pieces.push(item);
                    } else if (typeof item?.["#text"] === "string") {
                        pieces.push(item["#text"]);
                    }
                }
            } else if (typeof t === "string") {
                pieces.push(t);
            } else if (typeof t?.["#text"] === "string") {
                pieces.push(t["#text"]);
            }
        }
        
        // Handle space elements - <hp:s cnt="N"> represents N spaces
        const s = run?.s ?? run?.["hp:s"];
        if (s !== undefined && s !== null) {
            const sArr = Array.isArray(s) ? s : [s];
            for (const sElem of sArr) {
                const cnt = (typeof sElem === "object" && sElem?.["@cnt"])
                    ? Math.max(1, parseInt(sElem["@cnt"], 10) || 1)
                    : 1;
                pieces.push(" ".repeat(cnt));
            }
        }
        
        // Table embedded in run — extract cell text
        const tblInRun = run?.tbl ?? run?.["hp:tbl"];
        if (tblInRun) {
            const tbls = Array.isArray(tblInRun) ? tblInRun : [tblInRun];
            for (const tbl of tbls) {
                pieces.push(this.extractTableText(tbl));
            }
        }
        
        return pieces.join("");
    }
    
    // Extract plain text from a table node (traverses subList > p > run > t)
    extractTableText(tbl) {
        const rows = [];
        const trs = tbl?.tr ?? tbl?.["hp:tr"];
        const trArr = trs ? (Array.isArray(trs) ? trs : [trs]) : [];
        for (const tr of trArr) {
            const tcs = tr?.tc ?? tr?.["hp:tc"];
            const tcArr = tcs ? (Array.isArray(tcs) ? tcs : [tcs]) : [];
            const cellTexts = [];
            for (const tc of tcArr) {
                const subList = tc?.subList ?? tc?.["hp:subList"];
                const sls = subList ? (Array.isArray(subList) ? subList : [subList]) : [];
                const cellParts = [];
                for (const sl of sls) {
                    const ps = sl?.p ?? sl?.["hp:p"];
                    const paras = ps ? (Array.isArray(ps) ? ps : [ps]) : [];
                    for (const p of paras) {
                        const runs = p?.run ?? p?.["hp:run"];
                        const runArr = runs ? (Array.isArray(runs) ? runs : [runs]) : [];
                        const paraText = runArr.map((r) => this.extractRunText(r)).join("");
                        if (paraText) cellParts.push(paraText);
                    }
                }
                cellTexts.push(cellParts.join("\n"));
            }
            rows.push(cellTexts.join("\t"));
        }
        return rows.join("\n");
    }

    async extractText(options) {
        if (!this.zip)
            throw new HwpxNotLoadedError();
        const summary = this.summarizePackage();
        if (summary.hasEncryptionInfo) {
            throw new HwpxEncryptedDocumentError();
        }
        // HWPX 본문: Contents/section*.xml 에서 hp:t 텍스트를 추출
        const joiner = options?.joinParagraphs ?? "\n";
        let sectionPaths = this.getSectionPathsBySpine() ?? Object.keys(this.files)
            .filter((p) => /^contents\/section\d+\.xml$/.test(p.toLowerCase()))
            .sort((a, b) => {
            const na = Number(a.match(/section(\d+)\.xml/)?.[1] ?? 0);
            const nb = Number(b.match(/section(\d+)\.xml/)?.[1] ?? 0);
            return na - nb;
        });
        // Fallback: 탐색에 실패하면 Contents/*.xml 중 루트가 section 인 파일을 수색
        if (sectionPaths.length === 0) {
            const candidates = Object.keys(this.files).filter((p) => p.startsWith("Contents/") && p.toLowerCase().endsWith(".xml"));
            for (const p of candidates) {
                const xmlText = this.getTextFile(p);
                if (!xmlText)
                    continue;
                const xml = this.parseXml(xmlText);
                if (xml && (xml.sec || xml.section || xml["hp:section"])) {
                    sectionPaths.push(p);
                }
            }
            sectionPaths.sort((a, b) => {
                const na = Number(a.match(/section(\d+)\.xml/)?.[1] ?? 0);
                const nb = Number(b.match(/section(\d+)\.xml/)?.[1] ?? 0);
                return na - nb;
            });
        }
        const paragraphs = [];
        for (const path of sectionPaths) {
            const xmlText = this.getTextFile(path);
            if (!xmlText)
                continue;
            const xml = this.parseXml(xmlText);
            // 구조 참고: sec > p* > run* > t, 네임스페이스 제거됨
            const section = xml?.sec ?? xml?.section ?? xml?.["hp:section"];
            if (!section) {
                const segs = [];
                this.collectAllText(xml, segs);
                if (segs.length)
                    paragraphs.push(segs.join(""));
                continue;
            }
            const ps = section?.p ?? section?.["hp:p"];
            if (!ps) {
                const segs = [];
                this.collectAllText(section, segs);
                if (segs.length)
                    paragraphs.push(segs.join(""));
                continue;
            }
            const paras = Array.isArray(ps) ? ps : [ps];
            for (const p of paras) {
                const runs = p?.run ?? p?.["hp:run"];
                if (!runs) {
                    // 빈 문단 처리
                    paragraphs.push("");
                    continue;
                }
                const runArr = Array.isArray(runs) ? runs : [runs];
                const textPieces = [];
                for (const run of runArr) {
                    const runText = this.extractRunText(run);
                    if (runText) {
                        textPieces.push(runText);
                    }
                }
                paragraphs.push(textPieces.join(""));
            }
        }
        const combined = paragraphs.join(joiner);
        if (combined.trim().length > 0)
            return combined;
        // Fallback: Preview text
        const prvPath = this.findFilePathIgnoreCase("Preview/PrvText.txt") ||
            this.findFilePathIgnoreCase("preview/prvtext.txt");
        if (prvPath) {
            const prv = this.getTextFile(prvPath);
            if (prv && prv.trim().length > 0)
                return prv;
        }
        return combined;
    }
    // 아주 단순한 텍스트 템플릿 치환: {{key}} → value (문단 텍스트에만 적용)
    applyTemplateToText(raw, data) {
        return raw.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key) => {
            const value = key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), data);
            return value === undefined || value === null ? '' : String(value);
        });
    }
    
    // NEW: Get bullet or numbering text and indentation for a paragraph
    getBulletInfo(p, numberingCounters) {
        const paraPrIDRef = p?.["@paraPrIDRef"];
        if (!paraPrIDRef) return null;
        
        const paraPr = this.paragraphProperties.get(paraPrIDRef);
        if (!paraPr) return null;
        
        const heading = paraPr.heading;
        if (!heading) return null;
        
        // BULLET type: character bullet (•, -, etc.) stored in hh:bullets
        if (heading.type === "BULLET") {
            const bulletChar = this.bullets.get(String(heading.idRef)) ?? "•";
            if (!bulletChar) return null;
            const indent = paraPr.indent || {};
            return {
                text: bulletChar,
                indent: indent.intent || 0,
                leftMargin: indent.left || 0
            };
        }
        
        if (heading.type !== "NUMBER") return null;
        
        const numberingId = heading.idRef;
        const level = heading.level || 0;
        
        const numbering = this.numberings.get(numberingId);
        if (!numbering) return null;
        
        // Get the paraHead for the specified level
        const paraHeads = numbering.paraHeads || [];
        const paraHead = paraHeads[level];
        if (!paraHead) return null;
        
        // Get indentation from paragraph properties
        const indent = paraPr.indent || {};
        const indentValue = indent.intent || 0;
        const leftValue = indent.left || 0;
        
        // Process bullet/number text.
        // Template has a ^N placeholder (e.g. "^1.", "^3)", "(^5)", "^7").
        // N is the 1-based counter reference; the surrounding chars are prefix/suffix.
        let bulletText = paraHead.text || "";
        
        if (bulletText.includes("^")) {
            const key = `${numberingId}-${level}`;
            if (!numberingCounters[key]) numberingCounters[key] = 1;
            const counter = numberingCounters[key];
            const numFormat = paraHead.numFormat || "DIGIT";
            const formatted = this.formatCounter(counter, numFormat);
            // Replace first ^N (any digits) with formatted value
            bulletText = bulletText.replace(/\^\d+/, formatted);
            numberingCounters[key]++;
        }
        
        return {
            text: bulletText,
            indent: indentValue,
            leftMargin: leftValue
        };
    }
    
    /** Convert an integer counter to the requested HWPX numFormat string. */
    formatCounter(n, numFormat) {
        switch (numFormat) {
            case "HANGUL_SYLLABLE": {
                // 가, 나, 다, 라, 마, 바, 사, 아, 자, 차, 카, 타, 파, 하
                const syllables = ["가","나","다","라","마","바","사","아","자","차","카","타","파","하"];
                return syllables[(n - 1) % syllables.length] || String(n);
            }
            case "LATIN_SMALL": {
                // a, b, c, ..., z, aa, ab, ...
                let s = ""; let x = n;
                while (x > 0) { s = String.fromCharCode(96 + ((x - 1) % 26 + 1)) + s; x = Math.floor((x - 1) / 26); }
                return s;
            }
            case "LATIN_LARGE": {
                let s = ""; let x = n;
                while (x > 0) { s = String.fromCharCode(64 + ((x - 1) % 26 + 1)) + s; x = Math.floor((x - 1) / 26); }
                return s;
            }
            case "ROMAN_SMALL": {
                const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
                const syms = ["m","cm","d","cd","c","xc","l","xl","x","ix","v","iv","i"];
                let r = ""; let x = n;
                for (let i = 0; i < vals.length; i++) { while (x >= vals[i]) { r += syms[i]; x -= vals[i]; } }
                return r;
            }
            case "ROMAN_LARGE": {
                const vals = [1000,900,500,400,100,90,50,40,10,9,5,4,1];
                const syms = ["M","CM","D","CD","C","XC","L","XL","X","IX","V","IV","I"];
                let r = ""; let x = n;
                for (let i = 0; i < vals.length; i++) { while (x >= vals[i]) { r += syms[i]; x -= vals[i]; } }
                return r;
            }
            case "CIRCLED_DIGIT": {
                // ①②③...⑳ then plain number
                if (n >= 1 && n <= 20) return String.fromCharCode(0x2460 + n - 1);
                return String(n);
            }
            case "CIRCLED_HANGUL_SYLLABLE": {
                // ㉮㉯㉰... (U+326E+)
                if (n >= 1 && n <= 14) return String.fromCharCode(0x326E + n - 1);
                return String(n);
            }
            case "CIRCLED_LATIN_SMALL": {
                // ⓐⓑⓒ... (U+24D0+)
                if (n >= 1 && n <= 26) return String.fromCharCode(0x24D0 + n - 1);
                return String(n);
            }
            case "DIGIT":
            default:
                return String(n);
        }
    }
    
    async extractHtml(options) {
        if (!this.zip)
            throw new HwpxNotLoadedError();
        const summary = this.summarizePackage();
        if (summary.hasEncryptionInfo) {
            throw new HwpxEncryptedDocumentError();
        }
        const paragraphTag = options?.paragraphTag ?? "p";
        const enableImages = options?.renderImages ?? true;
        const enableTables = options?.renderTables ?? true;
        const enableStyles = options?.renderStyles ?? true;
        
        // NEW: Track numbering counters for ^1, ^2, etc. formats
        const numberingCounters = {};
        
        let sectionPaths = this.getSectionPathsBySpine() ?? Object.keys(this.files)
            .filter((p) => /^contents\/section\d+\.xml$/.test(p.toLowerCase()))
            .sort((a, b) => {
            const na = Number(a.match(/section(\d+)\.xml/)?.[1] ?? 0);
            const nb = Number(b.match(/section(\d+)\.xml/)?.[1] ?? 0);
            return na - nb;
        });
        if (sectionPaths.length === 0) {
            const candidates = Object.keys(this.files).filter((p) => p.startsWith("Contents/") && p.toLowerCase().endsWith(".xml"));
            for (const p of candidates) {
                const xmlText = this.getTextFile(p);
                if (!xmlText)
                    continue;
                const xml = this.parseXml(xmlText);
                if (xml && (xml.sec || xml.section || xml["hp:section"])) {
                    sectionPaths.push(p);
                }
            }
            sectionPaths.sort((a, b) => {
                const na = Number(a.match(/section(\d+)\.xml/)?.[1] ?? 0);
                const nb = Number(b.match(/section(\d+)\.xml/)?.[1] ?? 0);
                return na - nb;
            });
        }
        const pieces = [];
        for (const path of sectionPaths) {
            const xmlText = this.getTextFile(path);
            if (!xmlText)
                continue;
            const xml = this.parseXml(xmlText);
            const section = xml?.sec ?? xml?.section ?? xml?.["hp:section"];
            if (!section)
                continue;
            // paragraphs
            const ps = section?.p ?? section?.["hp:p"];
            if (ps) {
                const paras = Array.isArray(ps) ? ps : [ps];
                for (const p of paras) {
                    // Check for bullet/numbering with indentation
                    const bulletInfo = this.getBulletInfo(p, numberingCounters);
                    const inner = this.renderNodeToHtml(p, { enableImages, enableStyles, numberingCounters }, options);
                    const alignStyle = this.getAlignStyle(p);
                    
                    // Build style attribute
                    const styles = [];
                    if (alignStyle) styles.push(alignStyle);
                    
                    // Apply left-margin indentation from paraPr for ALL paragraphs.
                    // This covers both bulleted lists (via getBulletInfo) and plain
                    // indented paragraphs (type="NONE" with a non-zero hc:left value).
                    const paraPrIDRef = p?.["@paraPrIDRef"];
                    const paraPr = paraPrIDRef ? this.paragraphProperties.get(paraPrIDRef) : undefined;
                    const leftHwpUnit = paraPr?.indent?.left ?? (bulletInfo ? bulletInfo.leftMargin : 0);
                    if (leftHwpUnit > 0) {
                        // 1 HWPUNIT = 1/7200 inch; 72pt per inch → 1 HWPUNIT ≈ 0.01pt
                        // Practical formula: leftPt = leftHwpUnit / 100  (matches HWP screen rendering)
                        const leftPt = Math.round(leftHwpUnit / 100);
                        styles.push(`padding-left:${leftPt}pt`);
                    }
                    
                    const styleAttr = styles.length > 0 ? ` style="${styles.join(';')}"` : "";
                    
                    // If there's a bullet, prepend it to the content
                    const content = bulletInfo ? `${bulletInfo.text} ${inner}` : inner;
                    pieces.push(`<${paragraphTag}${styleAttr}>${content}</${paragraphTag}>`);
                }
            }
            // Direct section-level tables (rare but possible in some HWPX variants)
            const tbls = section?.tbl ?? section?.["hp:tbl"];
            if (tbls && enableTables) {
                const tables = Array.isArray(tbls) ? tbls : [tbls];
                for (const tbl of tables) {
                    pieces.push(this.renderTableToHtml(tbl, { enableImages, enableStyles, enableTables }, options));
                }
            }
        }
        let html = pieces.join("");
        if (html.trim().length > 0)
            return html;
        // Fallback: Preview text
        const prvPath = this.findFilePathIgnoreCase("Preview/PrvText.txt") ||
            this.findFilePathIgnoreCase("preview/prvtext.txt");
        if (prvPath) {
            const prv = this.getTextFile(prvPath);
            if (prv && prv.trim().length > 0) {
                const escaped = this.escapeHtml(prv);
                html = `<p>${escaped.replace(/\n+/g, '</p><p>')}</p>`;
            }
        }
        return html;
    }
    /**
     * Render a single hp:tbl node to HTML.
     * Handles both direct-child tables and run-embedded tables.
     * Cell content lives in hp:tc > hp:subList > hp:p (NOT directly in hp:tc).
     * Span info lives in hp:tc > hp:cellSpan[@colSpan/@rowSpan] child element.
     */
    renderTableToHtml(tbl, flags, options) {
        const tableClass = options?.tableClassName ?? "hwpx-table";
        const trs = tbl?.tr ?? tbl?.["hp:tr"];
        const rows = trs ? (Array.isArray(trs) ? trs : [trs]) : [];
        const rowHtml = [];
        rows.forEach((tr, rowIndex) => {
            const tcs = tr?.tc ?? tr?.["hp:tc"];
            const cells = tcs ? (Array.isArray(tcs) ? tcs : [tcs]) : [];
            const cellHtml = [];
            for (const tc of cells) {
                // Cell content is inside hp:subList, not directly inside hp:tc
                const inner = this.renderNodeToHtml(tc, flags, options);
                // Span info lives in child element hp:cellSpan, not as direct tc attributes
                const cellSpan = tc?.cellSpan ?? tc?.["hp:cellSpan"];
                const colSpan = cellSpan?.["@colSpan"] ?? cellSpan?.["@colspan"]
                    ?? tc?.["@colSpan"] ?? tc?.["@colspan"] ?? tc?.["@gridSpan"];
                const rowSpan = cellSpan?.["@rowSpan"] ?? cellSpan?.["@rowspan"]
                    ?? tc?.["@rowSpan"] ?? tc?.["@rowspan"];
                const subList = tc?.subList ?? tc?.["hp:subList"];
                const sl = Array.isArray(subList) ? subList[0] : subList;
                const alignStyle = this.getAlignStyle(sl) || this.getAlignStyle(tc);
                const attrs = [];
                if (colSpan && String(colSpan) !== "1")
                    attrs.push(` colspan="${String(colSpan)}"`);
                if (rowSpan && String(rowSpan) !== "1")
                    attrs.push(` rowspan="${String(rowSpan)}"`);
                if (alignStyle)
                    attrs.push(` style="${alignStyle}"`);
                const isHeader = options?.tableHeaderFirstRow && rowIndex === 0;
                const tag = isHeader ? "th" : "td";
                cellHtml.push(`<${tag}${attrs.join("")}>${inner}</${tag}>`);
            }
            rowHtml.push(`<tr>${cellHtml.join("")}</tr>`);
        });
        return `<table class="${tableClass}">${rowHtml.join("")}</table>`;
    }
    getAlignStyle(node) {
        const a = node?.["@align"] ?? node?.["@textAlign"] ?? node?.paraPr?.["@align"] ?? node?.cellPr?.["@align"];
        if (typeof a !== "string")
            return "";
        const v = a.toLowerCase();
        if (v === "center" || v === "right" || v === "left" || v === "justify") {
            return `text-align:${v}`;
        }
        return "";
    }
    renderNodeToHtml(node, flags, options) {
        if (!node)
            return "";
        // subList: HWPX table-cell content container — must be checked before p/run
        const subList = node?.["hp:subList"] ?? node?.subList;
        if (subList) {
            const sls = Array.isArray(subList) ? subList : [subList];
            return sls.map((sl) => this.renderNodeToHtml(sl, flags, options)).join("\n");
        }
        // paragraph aggregation — each <hp:p> in a cell becomes its own <p> so
        // paragraph breaks are visible in HTML (a bare "\n" join is invisible).
        const ps = node?.["hp:p"] ?? node?.p;
        if (ps) {
            const paras = Array.isArray(ps) ? ps : [ps];
            // numberingCounters flows through flags so sequential bullets stay in sync
            const counters = flags?.numberingCounters ?? {};
            return paras.map((p) => {
                const bulletInfo = this.getBulletInfo(p, counters);
                const inner = this.renderNodeToHtml(p, { ...flags, numberingCounters: counters }, options);
                // Carry per-paragraph left-indent; prefer paraPr, fall back to bulletInfo
                const paraPrIDRef = p?.["@paraPrIDRef"];
                const paraPr = paraPrIDRef ? this.paragraphProperties.get(paraPrIDRef) : undefined;
                const leftHwpUnit = paraPr?.indent?.left ?? (bulletInfo ? bulletInfo.leftMargin : 0);
                const styleAttr = leftHwpUnit > 0
                    ? ` style="padding-left:${Math.round(leftHwpUnit / 100)}pt"`
                    : "";
                const content = bulletInfo ? `${bulletInfo.text} ${inner}` : inner;
                return `<p${styleAttr}>${content}</p>`;
            }).join("");
        }
        // runs
        const runs = node?.["hp:run"] ?? node?.run;
        const runArr = runs ? (Array.isArray(runs) ? runs : [runs]) : [];
        if (runArr.length > 0) {
            return runArr.map((run) => this.renderRunToHtml(run, flags, options)).join("");
        }
        // direct text
        if (typeof node === "string")
            return this.escapeHtml(node);
        if (typeof node?.["#text"] === "string")
            return this.escapeHtml(node["#text"]);
        return "";
    }
    collectAllText(node, out) {
        if (node == null)
            return;
        // 설정 관련 노드들은 건너뛰기
        if (typeof node === "object" && (node.secPr || node.ctrl || node.linesegarray)) {
            return;
        }
        if (typeof node === "string") {
            out.push(node);
            return;
        }
        if (typeof node === "object") {
            const text = node["#text"];
            if (typeof text === "string")
                out.push(text);
            // 't' 속성이 있으면 직접 추출
            const t = node.t;
            if (typeof t === "string") {
                out.push(t);
                return; // t가 있으면 더 이상 탐색하지 않음
            }
            for (const [k, v] of Object.entries(node)) {
                if (k === "#text" || k === "t")
                    continue;
                // 설정 관련 키들은 건너뛰기
                if (k === "secPr" || k === "ctrl" || k === "linesegarray")
                    continue;
                this.collectAllText(v, out);
            }
        }
    }
    
    renderRunToHtml(run, flags, options) {
        // Skip runs that are ONLY section-property containers
        if (run?.secPr && !run?.tbl && !run?.t && !run?.s)
            return "";
        // Skip ctrl-only runs (column layout, page numbers, etc.) — but NOT if they also carry a tbl
        if (run?.ctrl && !run?.tbl && !run?.t && !run?.s)
            return "";
        
        // Collect text and spaces from run
        let html = "";
        
        // Handle text elements - can be single or array
        const t = run?.t ?? run?.["hp:t"];
        if (t !== undefined && t !== null) {
            if (Array.isArray(t)) {
                for (const item of t) {
                    if (typeof item === "string") {
                        html += this.escapeHtml(item);
                    } else if (typeof item?.["#text"] === "string") {
                        html += this.escapeHtml(item["#text"]);
                    }
                }
            } else if (typeof t === "string") {
                html += this.escapeHtml(t);
            } else if (typeof t?.["#text"] === "string") {
                html += this.escapeHtml(t["#text"]);
            }
        }
        
        // Handle space elements — <hp:s cnt="N"> means N spaces
        const s = run?.s ?? run?.["hp:s"];
        if (s !== undefined && s !== null) {
            const sArr = Array.isArray(s) ? s : [s];
            for (const sElem of sArr) {
                const cnt = (typeof sElem === "object" && sElem?.["@cnt"])
                    ? Math.max(1, parseInt(sElem["@cnt"], 10) || 1)
                    : 1;
                html += "\u00a0".repeat(cnt); // &nbsp; preserves multiple spaces in HTML
            }
        }
        
        // Image (simplified): hp:picture or hp:img-like reference to BinData
        if (flags.enableImages) {
            const pic = run?.picture ?? run?.["hp:picture"];
            const draw = run?.drawObject ?? run?.["hp:drawObject"];
            const img = run?.img ?? run?.["hp:img"];
            const hcImg = run?.["hc:img"];
            const binRef = this.getBinaryRefFromObject(pic, draw, img, hcImg);
            if (binRef) {
                const imgPath = this.resolveBinaryPath(binRef);
                const imgBytes = this.files[imgPath];
                if (imgBytes) {
                    const mime = this.detectMimeType(imgPath);
                    const b64 = this.toBase64(imgBytes);
                    html += `<img src="data:${mime};base64,${b64}" alt="Image" style="max-width:100%;"/>`;
                }
            }
        }
        // Table embedded directly inside a run (most common HWPX pattern)
        if (flags.enableTables !== false) {
            const tblInRun = run?.tbl ?? run?.["hp:tbl"];
            if (tblInRun) {
                const tbls = Array.isArray(tblInRun) ? tblInRun : [tblInRun];
                html += tbls.map((t) => this.renderTableToHtml(t, flags, options)).join("");
            }
        }
        // Apply character style
        if (flags.enableStyles) {
            const charPrIDRef = run?.["@charPrIDRef"];
            if (charPrIDRef) {
                const charPr = this.characterProperties.get(charPrIDRef);
                if (charPr) {
                    const styles = [];
                    // Font size
                    if (charPr.height) {
                        const pts = this.convertHwpUnitToPoints(charPr.height);
                        styles.push(`font-size:${pts}pt`);
                    }
                    // Text color
                    if (charPr.textColor && charPr.textColor !== "none" && charPr.textColor !== "#000000") {
                        styles.push(`color:${this.normalizeColor(charPr.textColor)}`);
                    }
                    // Background color
                    if (charPr.shadeColor && charPr.shadeColor !== "none") {
                        styles.push(`background-color:${this.normalizeColor(charPr.shadeColor)}`);
                    }
                    if (styles.length > 0 || charPr.bold || charPr.italic) {
                        const opening = [];
                        const closing = [];
                        if (charPr.bold) {
                            opening.push('<strong>');
                            closing.unshift('</strong>');
                        }
                        if (charPr.italic) {
                            opening.push('<em>');
                            closing.unshift('</em>');
                        }
                        if (styles.length > 0) {
                            opening.push(`<span style="${styles.join(';')}">`);
                            closing.unshift('</span>');
                        }
                        html = opening.join('') + html + closing.join('');
                    }
                }
            }
        }
        return html;
    }
    getBinaryRefFromObject(pic, draw, img, hcImg) {
        // priority: picture → drawObject → img
        const tryExtract = (node) => {
            if (!node)
                return undefined;
            // Check for binaryItemIDRef attribute (used by hc:img)
            const binaryRef = node?.["@binaryItemIDRef"];
            if (typeof binaryRef === "string")
                return binaryRef;
            // For picture elements, the img may be nested inside (hc:img becomes nested img)
            const nestedImg = node?.img;
            if (nestedImg && typeof nestedImg?.["@binaryItemIDRef"] === "string") {
                return nestedImg["@binaryItemIDRef"];
            }
            // Check for traditional hp:binItem reference
            const ref = node?.["hp:binItem"]?.["@ref"] ?? node?.binItem?.["@ref"] ?? node?.["@ref"];
            if (typeof ref === "string")
                return ref;
            return undefined;
        };
        return tryExtract(pic) || tryExtract(draw) || tryExtract(img) || tryExtract(hcImg);
    }
    resolveBinaryPath(binRef) {
        // First, try direct path (legacy format)
        const directPath = `BinData/${binRef}`;
        if (this.files[directPath]) {
            return directPath;
        }
        // Try to resolve through manifest
        try {
            const summary = this.summarizePackage();
            if (summary.manifest) {
                const manifestItem = summary.manifest.find(item => item.id === binRef);
                if (manifestItem?.href) {
                    // The href might include the full path or relative path
                    const resolvedPath = manifestItem.href.startsWith('BinData/')
                        ? manifestItem.href
                        : `BinData/${manifestItem.href}`;
                    if (this.files[resolvedPath]) {
                        return resolvedPath;
                    }
                    // Try the href as-is
                    if (this.files[manifestItem.href]) {
                        return manifestItem.href;
                    }
                }
            }
        }
        catch (e) {
            // Fall back if manifest parsing fails
        }
        // Fallback: return the direct path even if file doesn't exist
        return directPath;
    }
    normalizeColor(c) {
        const s = c.trim();
        if (/^#?[0-9a-fA-F]{6}$/.test(s))
            return s.startsWith('#') ? s : `#${s}`;
        return s; // fallback as-is
    }
    normalizeSize(sz) {
        const n = typeof sz === 'number' ? sz : Number(sz);
        if (!isNaN(n))
            return `${n}pt`;
        return String(sz);
    }
    convertHwpUnitToPoints(hwpUnit) {
        // HWPUNIT is approximately 1/100th of a point
        // 1000 HWPUNIT = 10 points
        const units = typeof hwpUnit === 'number' ? hwpUnit : parseInt(String(hwpUnit), 10);
        return Math.round((units / 100) * 10) / 10; // Round to 1 decimal place
    }
    parseStyleDefinitions() {
        // Clear existing definitions
        this.characterProperties.clear();
        this.fontFaces.clear();
        this.paragraphProperties.clear();
        this.numberings.clear();
        this.bullets.clear();
        
        // Find and parse header.xml
        const headerXml = this.getTextFile("Contents/header.xml");
        if (!headerXml)
            return;
        try {
            const header = this.parseXml(headerXml);
            const root = header?.head ?? header;
            if (!root) {
                console.log("No root found in header");
                return;
            }
            // Character properties are in head/refList/charProperties
            const refList = root?.refList;
            if (!refList) {
                console.log("No refList found, available keys:", Object.keys(root));
                return;
            }
            // Parse font faces
            const fontfaces = refList?.fontfaces;
            if (fontfaces?.fontface) {
                const fonts = Array.isArray(fontfaces.fontface) ? fontfaces.fontface : [fontfaces.fontface];
                for (const font of fonts) {
                    const id = font?.["@id"];
                    if (id) {
                        this.fontFaces.set(id, font);
                    }
                }
            }
            // Parse character properties from refList
            const charProperties = refList?.charProperties;
            if (charProperties?.charPr) {
                const charPrs = Array.isArray(charProperties.charPr) ? charProperties.charPr : [charProperties.charPr];
                for (const charPr of charPrs) {
                    const id = charPr?.["@id"];
                    if (id) {
                        this.characterProperties.set(id, this.processCharacterProperties(charPr));
                    }
                }
            }
            
            // NEW: Parse numberings
            const numberings = refList?.numberings;
            if (numberings?.numbering) {
                const numberingList = Array.isArray(numberings.numbering) ? numberings.numbering : [numberings.numbering];
                for (const numbering of numberingList) {
                    const id = numbering?.["@id"];
                    if (id) {
                        this.numberings.set(id, this.processNumbering(numbering));
                    }
                }
            }
            
            // Parse bullet definitions: hh:bullets > hh:bullet[@id, @char]
            const bulletsNode = refList?.bullets;
            if (bulletsNode?.bullet) {
                const bulletList = Array.isArray(bulletsNode.bullet) ? bulletsNode.bullet : [bulletsNode.bullet];
                for (const b of bulletList) {
                    const id = b?.["@id"];
                    const char = b?.["@char"] ?? "";
                    if (id !== undefined) this.bullets.set(String(id), char);
                }
            }
            
            // NEW: Parse paragraph properties from refList
            const paraProperties = refList?.paraProperties;
            if (paraProperties?.paraPr) {
                const paraPrs = Array.isArray(paraProperties.paraPr) ? paraProperties.paraPr : [paraProperties.paraPr];
                for (const paraPr of paraPrs) {
                    const id = paraPr?.["@id"];
                    if (id) {
                        this.paragraphProperties.set(id, this.processParagraphProperties(paraPr));
                    }
                }
            }
        }
        catch (error) {
            // Silent fail - styles are optional
            console.warn("Failed to parse style definitions:", error);
        }
    }
    
    // NEW: Process numbering definition
    processNumbering(numbering) {
        const paraHeads = numbering?.paraHead;
        if (!paraHeads) return { paraHeads: [] };
        
        const heads = Array.isArray(paraHeads) ? paraHeads : [paraHeads];
        const processed = heads.map(head => {
            const level = parseInt(head?.["@level"] || "0", 10);
            // The text content of paraHead is the bullet/number format
            // It could be a symbol like "●", "○", "■" or a format string like "^1."
            const text = typeof head === "string" ? head : 
                         (head?.["#text"] || head?.text || "");
            
            return {
                level: level,
                text: text,
                align: head?.["@align"],
                numFormat: head?.["@numFormat"]
            };
        });
        
        return { paraHeads: processed };
    }
    
    // NEW: Process paragraph properties
    processParagraphProperties(paraPr) {
        const heading = paraPr?.heading;
        
        // Extract indentation values from margin (handle hp:switch structure)
        let indent = {};
        
        // The margin can be in different places:
        // 1. Directly under paraPr
        // 2. Inside hp:switch > hp:case
        // 3. Inside hp:switch > hp:default
        let margin = paraPr?.margin;
        
        // Check for switch structure
        if (!margin && paraPr?.switch) {
            const switchElem = paraPr.switch;
            // Try case first, then default
            margin = switchElem?.case?.margin || switchElem?.default?.margin;
        }
        
        if (margin) {
            // Check for hc:intent and hc:left in the margin
            const intentElem = margin?.intent;
            const leftElem = margin?.left;
            
            if (intentElem) {
                const val = intentElem?.["@value"];
                if (val) {
                    indent.intent = parseInt(val, 10);
                }
            }
            if (leftElem) {
                const val = leftElem?.["@value"];
                if (val) {
                    indent.left = parseInt(val, 10);
                }
            }
        }
        
        const result = { indent };
        
        if (heading) {
            result.heading = {
                type: heading?.["@type"],
                idRef: heading?.["@idRef"],
                level: parseInt(heading?.["@level"] || "0", 10)
            };
        }
        
        return result;
    }
    
    processCharacterProperties(charPr) {
        // Bold is indicated by presence of <hh:bold/> element (after namespace removal, becomes 'bold')
        const hasBold = charPr?.bold !== undefined;
        const hasItalic = charPr?.italic !== undefined;
        return {
            height: charPr?.["@height"], // Font size in HWPUNIT
            textColor: charPr?.["@textColor"], // Text color
            shadeColor: charPr?.["@shadeColor"], // Background color
            bold: hasBold, // Bold formatting (element presence)
            italic: hasItalic, // Italic formatting (element presence)
            underline: charPr?.underline, // Underline info
            strikeout: charPr?.strikeout, // Strikeout info
            fontRef: charPr?.fontRef, // Font reference
            raw: charPr // Keep original for debugging
        };
    }
    detectMimeType(path) {
        const lower = path.toLowerCase();
        if (lower.endsWith(".png"))
            return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg"))
            return "image/jpeg";
        if (lower.endsWith(".gif"))
            return "image/gif";
        if (lower.endsWith(".bmp"))
            return "image/bmp";
        if (lower.endsWith(".webp"))
            return "image/webp";
        return "application/octet-stream";
    }
    toBase64(bytes) {
        if (typeof Buffer !== "undefined") {
            return Buffer.from(bytes).toString("base64");
        }
        let binary = "";
        for (let i = 0; i < bytes.length; i++)
            binary += String.fromCharCode(bytes[i]);
        // btoa may not exist in Node, handled by Buffer path above
        // @ts-ignore
        return btoa(binary);
    }
    extractTextFromNode(node) {
        if (!node)
            return "";
        // subList: table-cell content container — check before p/run
        const subList = node?.["hp:subList"] ?? node?.subList;
        if (subList) {
            const sls = Array.isArray(subList) ? subList : [subList];
            return sls.map((sl) => this.extractTextFromNode(sl)).join("\n");
        }
        // hp:p → hp:run → hp:t
        const ps = node?.["hp:p"] ?? node?.p;
        if (ps) {
            const paras = Array.isArray(ps) ? ps : [ps];
            return paras.map((p) => this.extractTextFromNode(p)).join("\n");
        }
        const runs = node?.["hp:run"] ?? node?.run;
        const runArr = runs ? (Array.isArray(runs) ? runs : [runs]) : [];
        const textPieces = [];
        for (const run of runArr) {
            const runText = this.extractRunText(run);
            if (runText) {
                textPieces.push(runText);
            }
        }
        if (textPieces.length > 0)
            return textPieces.join("");
        // direct text
        if (typeof node === "string")
            return node;
        if (typeof node?.["#text"] === "string")
            return node["#text"];
        return "";
    }
    escapeHtml(text) {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
    async listImages() {
        if (!this.zip)
            throw new HwpxNotLoadedError();
        // 이미지: BinData/ 내 파일들 (원 규격상 다양한 바이너리 포함)
        return Object.keys(this.files)
            .filter((p) => p.startsWith("BinData/") && !p.endsWith("/"))
            .sort();
    }
}
export default HwpxReader;