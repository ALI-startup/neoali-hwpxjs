/**
 * HWP file structure interfaces
 */
export interface HWPFileHeader {
    version: string;
    encryptMethod: number;
    distributionId: string;
}
export interface HWPCharShape {
    faceNameIds: {
        hangul: number;
        latin: number;
        hanja: number;
        japanese: number;
        other: number;
        symbol: number;
        user: number;
    };
    ratios: number[];
    charSpaces: number[];
    relativeSizes: number[];
    charOffsets: number[];
    baseSize: number;
    property: number;
    shadowGap1: number;
    shadowGap2: number;
    charColor: number;
    underLineColor: number;
    shadeColor: number;
    shadowColor: number;
    borderFillId: number;
    strikeOutColor: number;
}
export interface HWPParaShape {
    property: number;
    leftMargin: number;
    rightMargin: number;
    indent: number;
    prevSpacing: number;
    nextSpacing: number;
    lineSpacing: number;
    tabDefId: number;
    numbering: number;
    borderFillId: number;
    borderOffsetLeft: number;
    borderOffsetRight: number;
    borderOffsetTop: number;
    borderOffsetBottom: number;
}
export interface HWPFontFace {
    name: string;
    property: number;
    type: number;
    family: number;
}
export interface HWPSection {
    paragraphs: HWPParagraph[];
}
export interface HWPParagraph {
    paraShapeId: number;
    styleId: number;
    chars: HWPChar[];
}
export interface HWPChar {
    type: 'Normal' | 'ControlChar' | 'ControlInline' | 'ControlExtend';
    code: number;
    charShapeId: number;
    content?: string | any;
}
export interface HWPFile {
    fileHeader: HWPFileHeader;
    docInfo: {
        charShapes: HWPCharShape[];
        paraShapes: HWPParaShape[];
        fontFaces: HWPFontFace[];
        styles: any[];
        borderFills: any[];
        bullets: any[];
        numberings: any[];
    };
    bodyText: {
        sections: HWPSection[];
    };
    binData: Map<string, Uint8Array>;
}
/**
 * Simple HWP file reader (basic implementation)
 * Note: This is a simplified implementation focusing on text content
 * Full HWP parsing would require complete OLE compound document support
 */
export declare class HWPReader {
    private buffer;
    constructor(buffer: ArrayBuffer);
    /**
     * Create HWPReader from file buffer
     */
    static fromBuffer(buffer: ArrayBuffer): HWPReader;
    /**
     * Parse HWP file and return structured data
     * Note: This is a minimal implementation that focuses on extracting text content
     * A complete implementation would require full OLE document parsing
     */
    parseHWP(): HWPFile;
    /**
     * Convert HWP to HWPX format
     */
    convertToHWPX(): Promise<Uint8Array>;
    private isHWPFile;
    private createBasicHWPStructure;
    private createDefaultCharShape;
    private createDefaultParaShape;
    private createDefaultFontFace;
    private createSampleSection;
    private convertHWPToHWPX;
    private extractTextFromHWP;
}
