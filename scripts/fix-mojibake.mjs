#!/usr/bin/env node
/**
 * Fix double-encoded UTF-8 mojibake in source files.
 *
 * Symptom: text like "status â€” org" in output (an em-dash rendered as 3
 * mojibake chars). Cause: the original UTF-8 bytes (e.g. U+2014 = E2 80 94)
 * were read as CP1252 (â € ”) and re-saved as UTF-8.
 *
 * Fix: for each line, re-encode the mojibake characters back to CP1252 bytes
 * and decode as UTF-8. Only lines whose characters are ALL representable in
 * CP1252 (Latin-1 range + the 0x80-0x9F specials) are touched — a line with
 * legitimately typed non-CP1252 Unicode (emoji, CJK, arrows, etc.) is
 * skipped and reported, so legit Unicode can never be corrupted.
 */
import { readFileSync, writeFileSync } from "node:fs";

// CP1252 byte values for the characters that differ from Latin-1.
const CP1252_SPECIAL = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // “
  0x201d: 0x94, // ”
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

/** Encode a string to CP1252 bytes, or null if any char is unrepresentable. */
function encodeCp1252(s) {
  const bytes = [];
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code <= 0xff) {
      bytes.push(code);
    } else if (CP1252_SPECIAL[code] !== undefined) {
      bytes.push(CP1252_SPECIAL[code]);
    } else {
      return null;
    }
  }
  return Buffer.from(bytes);
}

const FILES = process.argv.slice(2);
let fixedLines = 0;
let skippedLines = 0;

for (const file of FILES) {
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  let changed = 0;

  const out = lines.map((line) => {
    const bytes = encodeCp1252(line);
    if (bytes === null) {
      if (/[\u0080-\uffff]/.test(line)) skippedLines++;
      return line;
    }
    const decoded = bytes.toString("utf8");
    if (decoded === line) return line;
    if (decoded.includes("\ufffd")) return line;
    changed++;
    return decoded;
  });

  if (changed > 0) {
    writeFileSync(file, out.join("\n"), "utf8");
    fixedLines += changed;
    console.log(`  ${file}: fixed ${changed} line(s)`);
  }
}

console.log(`\nDone. Fixed ${fixedLines} line(s), skipped ${skippedLines}.`);
