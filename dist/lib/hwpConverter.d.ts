/**
 * Options for HWP to HWPX conversion
 */
export interface HwpConversionOptions {
    /** Enable verbose logging during conversion */
    verbose?: boolean;
    /** Extract images from HWP file (not implemented yet) */
    extractImages?: boolean;
    /** Preserve formatting information (not implemented yet) */
    preserveFormatting?: boolean;
}
/**
 * Result of HWP to HWPX conversion
 */
export interface HwpConversionResult {
    /** Whether the conversion was successful */
    success: boolean;
    /** Output HWPX file path if successful */
    outputPath?: string;
    /** Error message if failed */
    error?: string;
    /** Standard output from the Java process */
    stdout?: string;
    /** Standard error from the Java process */
    stderr?: string;
}
/**
 * HWP to HWPX converter using pure TypeScript implementation
 */
export declare class HwpConverter {
    private verbose;
    private extractImages;
    private preserveFormatting;
    constructor(options?: HwpConversionOptions);
    /**
     * Convert HWP file to HWPX format
     */
    convertHwpToHwpx(inputPath: string, outputPath: string): Promise<HwpConversionResult>;
    /**
     * Check if the HWP converter is available
     */
    isAvailable(): Promise<boolean>;
    /**
     * Get information about the converter setup
     */
    getInfo(): object;
    /**
     * Convert HWP file content to text
     */
    convertHwpToText(inputPath: string): Promise<string>;
}
