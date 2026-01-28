import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HWPReader } from './hwpReader.js';
/**
 * HWP to HWPX converter using pure TypeScript implementation
 */
export class HwpConverter {
    verbose;
    extractImages;
    preserveFormatting;
    constructor(options = {}) {
        this.verbose = options.verbose || false;
        this.extractImages = options.extractImages || false;
        this.preserveFormatting = options.preserveFormatting || false;
    }
    /**
     * Convert HWP file to HWPX format
     */
    async convertHwpToHwpx(inputPath, outputPath) {
        try {
            if (this.verbose) {
                console.log(`Reading HWP file: ${inputPath}`);
            }
            // Read HWP file
            const inputBuffer = await readFile(resolve(inputPath));
            const hwpReader = HWPReader.fromBuffer(inputBuffer.buffer);
            if (this.verbose) {
                console.log('Parsing HWP file structure...');
            }
            // Convert HWP to HWPX
            const hwpxBuffer = await hwpReader.convertToHWPX();
            if (this.verbose) {
                console.log(`Writing HWPX file: ${outputPath}`);
            }
            // Write HWPX file
            const { writeFile } = await import('node:fs/promises');
            await writeFile(resolve(outputPath), hwpxBuffer);
            return {
                success: true,
                outputPath: resolve(outputPath),
                stdout: this.verbose ? 'HWP to HWPX conversion completed successfully' : undefined
            };
        }
        catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }
    /**
     * Check if the HWP converter is available
     */
    async isAvailable() {
        try {
            // For pure TypeScript implementation, always return true
            // since we don't depend on external tools
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * Get information about the converter setup
     */
    getInfo() {
        return {
            implementation: 'Pure TypeScript',
            verbose: this.verbose,
            extractImages: this.extractImages,
            preserveFormatting: this.preserveFormatting,
            features: [
                'Text extraction',
                'Basic structure preservation',
                this.extractImages ? 'Image extraction (experimental)' : 'Image extraction (disabled)',
                this.preserveFormatting ? 'Formatting preservation (experimental)' : 'Formatting preservation (disabled)'
            ]
        };
    }
    /**
     * Convert HWP file content to text
     */
    async convertHwpToText(inputPath) {
        try {
            const inputBuffer = await readFile(resolve(inputPath));
            const hwpReader = HWPReader.fromBuffer(inputBuffer.buffer);
            const hwpFile = hwpReader.parseHWP();
            // Extract text content
            const textParts = [];
            for (const section of hwpFile.bodyText.sections) {
                for (const paragraph of section.paragraphs) {
                    const paragraphText = [];
                    for (const char of paragraph.chars) {
                        if (char.type === 'Normal' && char.content) {
                            paragraphText.push(char.content);
                        }
                        else if (char.type === 'ControlChar') {
                            switch (char.code) {
                                case 10: // Line break
                                case 13: // Paragraph break
                                    paragraphText.push('\n');
                                    break;
                                case 9: // Tab
                                    paragraphText.push('\t');
                                    break;
                                case 24: // Hyphen
                                    paragraphText.push('-');
                                    break;
                                case 30: // Non-breaking space
                                case 31: // Fixed-width space
                                    paragraphText.push(' ');
                                    break;
                            }
                        }
                    }
                    if (paragraphText.length > 0) {
                        textParts.push(paragraphText.join(''));
                    }
                }
            }
            return textParts.join('\n');
        }
        catch (error) {
            throw new Error(`Failed to extract text from HWP file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
