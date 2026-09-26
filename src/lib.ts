// Node-side library entry (tests, harness server, CLI). No vscode dependency.
export * from './core';
export * as store from './commentStore';
export * from './blockEdit';
export * from './render';
export * from './inlineEdit';
export * from './editHistory';
export * from './agentPrompt';
export * from './reviewPresets';
export { insideRealRoots, loadBibliography, parseBibTeX, parseCslJson, realRoots } from './bibliography';
export * from './agentLaunch';
export * from './redlines';
export * from './wordDiff';
export * from './baselineStore';
export * from './fileWatch';
export { inlineImage } from './localImage';
export * as inbox from './inbox';
export { locate, locateLoose, quoteAt } from './textQuote';
export { buildDocModel, modelFromHtml, tokenizeHtml, linesAt, isLocalImage } from './docModel';
export { writeZip, readZip, openZip, crc32, ZipError, LIMITS as zipLimits } from './zip';
export { exportDocx, exportTargetProblem, threadsToExport, writeDocxFile, xml as xmlEscape } from './docx';
export { importDocx, readDocx, placeQuote, splitMeta, widenToWords, xmlTokens } from './wordImport';

export * from './sourceEdit';
