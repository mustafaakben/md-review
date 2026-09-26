// Node-side library entry (tests, harness server, CLI). No vscode dependency.
export * from './core';
export * as store from './commentStore';
export * from './blockEdit';
export * from './render';
export * from './inlineEdit';
export * from './editHistory';
export * from './agentPrompt';
export * from './reviewPresets';
export { loadBibliography, parseBibTeX, parseCslJson } from './bibliography';
export * from './agentLaunch';
export * from './redlines';
export * from './wordDiff';
export * from './baselineStore';
