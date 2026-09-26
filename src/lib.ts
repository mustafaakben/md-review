// Node-side library entry (tests, harness server, CLI). No vscode dependency.
export * from './core';
export * as store from './commentStore';
export * from './blockEdit';
export * from './render';
export * from './inlineEdit';
export * from './editHistory';
export * from './agentPrompt';
export { parseBibTeX, parseCslJson } from './bibliography';
