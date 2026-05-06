# neoali-hwpxjs

A fork of [@ssabrojs/hwpxjs](https://github.com/ssabro/hwpxjs) with improved spacing handling for Pandoc-generated HWPX, and fixes for correct table rendering in document order.

## Features
- Correct spacing between inline elements
- Compatible with Pandoc HWPX output
- Tables rendered in proper document order (embedded `run > tbl` structure supported)

## Setup

Install dependencies once:

```bash
npm install
```

## CLI Usage

### Single file — HTML output

```bash
node dist/cli.js html test.hwpx > output.html
```

### Single file — plain text output

```bash
node dist/cli.js txt test.hwpx
```

### Inspect document metadata

```bash
node dist/cli.js inspect test.hwpx
```

### Batch convert a folder to HTML

```bash
node dist/cli.js batch inFolder/ outFolder/
```

### Template rendering (replace `{{key}}` placeholders)

```bash
node dist/cli.js html:tpl test.hwpx data.json
node dist/cli.js batch:tpl inFolder/ dataFolder/ outFolder/
```

### Write plain text into a new HWPX file

```bash
node dist/cli.js write:txt input.txt output.hwpx
```

### HWP (legacy) commands

```bash
node dist/cli.js hwp:txt test.hwp        # extract text from HWP
node dist/cli.js convert:hwp in.hwp out.hwpx # convert HWP → HWPX
```

## Shorter commands

**npm script** — add to `package.json`:

```json
"scripts": {
  "hwpx": "node dist/cli.js"
}
```

Then run:

```bash
npm run hwpx -- html test.hwpx > output.html
```

**Global install** — install once, use anywhere:

```bash
npm install -g .
hwpx html test.hwpx > output.html
```

## Programmatic Usage

```js
const { HwpxReader } = await import("neoali-hwpxjs");

const reader = new HwpxReader();
const buf = await fs.readFile("test.hwpx");
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

await reader.loadFromArrayBuffer(ab);

const html = await reader.extractHtml({ embedImages: true, tableHeaderFirstRow: true });
const text = await reader.extractText();
const info = await reader.getDocumentInfo();
```