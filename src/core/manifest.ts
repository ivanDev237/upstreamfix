/** Parse a JSON package manifest while accepting the UTF-8 BOM used by some editors. */
export function parseManifest<T>(contents: string): T {
  return JSON.parse(contents.replace(/^\uFEFF/, '')) as T;
}
