// The extra writing fonts the reading panel lists under "More fonts". They ship
// with the extension (all SIL Open Font License): esbuild.mjs copies each one's
// Latin and Latin Extended files into media/fonts and writes fonts.css from this
// list, the view offers them, and the host keeps only these ids in the prefs.

export type FontGroup = 'sans' | 'serif' | 'mono';

export interface ReadingFontDef {
  id: string;
  label: string;
  group: FontGroup;
  /** A few words on its character, shown under the name. */
  note: string;
  /** The @font-face family the build defines. */
  family: string;
  /** Text size, for faces that look small at the default 16px. */
  size?: string;
  /** Where the build takes the font from: Fontsource CSS files in a package, or iA's files in fonts/ia-writer. */
  source: { pkg: string; css: string[] } | { ia: string };
}

export const FONT_GROUPS: [FontGroup, string][] = [['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']];

const variable = (name: string) => ({ pkg: `@fontsource-variable/${name}`, css: ['wght.css', 'wght-italic.css'] });

export const EXTRA_FONTS: ReadingFontDef[] = [
  { id: 'albert-sans', label: 'Albert Sans', group: 'sans', note: 'Closest to Bear Sans', family: 'Albert Sans Variable', source: variable('albert-sans') },
  { id: 'figtree', label: 'Figtree', group: 'sans', note: 'Friendly and very readable', family: 'Figtree Variable', source: variable('figtree') },
  { id: 'dm-sans', label: 'DM Sans', group: 'sans', note: 'Round and calm', family: 'DM Sans Variable', source: variable('dm-sans') },
  { id: 'plus-jakarta-sans', label: 'Plus Jakarta Sans', group: 'sans', note: 'Modern and warm', family: 'Plus Jakarta Sans Variable', source: variable('plus-jakarta-sans') },
  { id: 'manrope', label: 'Manrope', group: 'sans', note: 'Geometric meets grotesque', family: 'Manrope Variable', source: { pkg: '@fontsource-variable/manrope', css: ['wght.css'] } },
  { id: 'instrument-sans', label: 'Instrument Sans', group: 'sans', note: 'Crisp and neat', family: 'Instrument Sans Variable', source: variable('instrument-sans') },
  { id: 'atkinson', label: 'Atkinson Hyperlegible', group: 'sans', note: 'Made for legibility', family: 'Atkinson Hyperlegible Next Variable', source: variable('atkinson-hyperlegible-next') },
  { id: 'newsreader', label: 'Newsreader', group: 'serif', note: 'Editorial, for the screen', family: 'Newsreader Variable', size: '17px', source: variable('newsreader') },
  { id: 'literata', label: 'Literata', group: 'serif', note: 'Google Books’ reading face', family: 'Literata Variable', source: variable('literata') },
  { id: 'eb-garamond', label: 'EB Garamond', group: 'serif', note: 'Classic and literary', family: 'EB Garamond Variable', size: '17.5px', source: variable('eb-garamond') },
  { id: 'fraunces', label: 'Fraunces', group: 'serif', note: 'Soft, with character', family: 'Fraunces Variable', source: variable('fraunces') },
  { id: 'ia-mono', label: 'iA Writer Mono', group: 'mono', note: 'iA Writer’s own face', family: 'iA Writer Mono S', size: '15px', source: { ia: 'iAWriterMonoS' } },
  { id: 'ia-duo', label: 'iA Writer Duo', group: 'mono', note: 'Mono feel, wider letters get room', family: 'iA Writer Duo S', size: '15px', source: { ia: 'iAWriterDuoS' } },
  { id: 'plex-mono', label: 'IBM Plex Mono', group: 'mono', note: 'Typewriter-like', family: 'IBM Plex Mono', size: '15px', source: { pkg: '@fontsource/ibm-plex-mono', css: ['400.css', '400-italic.css', '600.css', '600-italic.css'] } },
];

/** The family list for a font: its face, then the system faces of its kind. */
export function fontStack(f: ReadingFontDef): string {
  const rest = f.group === 'sans' ? "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" : f.group === 'serif' ? 'var(--font-writer-book)' : 'var(--font-writer-mono)';
  return `'${f.family}', ${rest}`;
}

export const isExtraFont = (id: unknown): id is string => typeof id === 'string' && EXTRA_FONTS.some((f) => f.id === id);
