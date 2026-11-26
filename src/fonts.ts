import { mediaUrl } from "./engine/mediaPool";
import type { Project } from "./model/types";
import type { CustomFont } from "./api";

export const SYSTEM_FONTS = ["Segoe UI", "Arial", "Arial Black", "Impact", "Georgia", "Times New Roman", "Verdana", "Trebuchet MS", "Courier New", "Comic Sans MS"];

/** Popular Google Fonts (all under the Open Font License or Apache 2.0), downloaded on first use. */
export const GOOGLE_FONTS = [
  "Roboto",
  "Open Sans",
  "Montserrat",
  "Poppins",
  "Inter",
  "Lato",
  "Oswald",
  "Raleway",
  "Nunito",
  "Rubik",
  "Work Sans",
  "Kanit",
  "Barlow",
  "DM Sans",
  "Quicksand",
  "Josefin Sans",
  "Bebas Neue",
  "Anton",
  "Archivo Black",
  "Righteous",
  "Bangers",
  "Luckiest Guy",
  "Fredoka",
  "Comfortaa",
  "Playfair Display",
  "Merriweather",
  "Abril Fatface",
  "Lobster",
  "Pacifico",
  "Dancing Script",
  "Great Vibes",
  "Satisfy",
  "Caveat",
  "Permanent Marker",
  "Shadows Into Light",
  "Press Start 2P",
];

const loaded = new Map<string, Promise<void>>();

/** Make a Google Font available to the canvas (downloads it the first time). */
export function loadGoogleFont(family: string): Promise<void> {
  let p = loaded.get(family);
  if (!p) {
    p = (async () => {
      const { files } = await window.api.ensureFont(family);
      await Promise.all(
        files.map(async (f) => {
          const face = new FontFace(family, `url("${mediaUrl(f.path)}")`, {
            weight: f.weight,
            style: f.style,
            ...(f.unicodeRange ? { unicodeRange: f.unicodeRange } : {}),
          });
          document.fonts.add(await face.load());
        }),
      );
    })();
    p.catch(() => loaded.delete(family));
    loaded.set(family, p);
  }
  return p;
}

let customLoad: Promise<CustomFont[]> | null = null;
const customFaces = new Set<string>();

/** Register the user's imported font files with the document (once per file). */
export function loadCustomFonts(refresh = false): Promise<CustomFont[]> {
  if (!customLoad || refresh) {
    customLoad = (async () => {
      const list = await window.api.customFonts();
      await Promise.allSettled(
        list
          .filter((f) => !customFaces.has(f.path))
          .map(async (f) => {
            const face = new FontFace(f.family, `url("${mediaUrl(f.path)}")`, { weight: f.weight, style: f.style });
            document.fonts.add(await face.load());
            customFaces.add(f.path);
          }),
      );
      return list;
    })();
    customLoad.catch(() => (customLoad = null));
  }
  return customLoad;
}

let installed: Promise<string[]> | null = null;

/** Families of the fonts installed on this computer (Local Font Access API); empty if unavailable. */
export function installedFonts(): Promise<string[]> {
  if (!installed) {
    installed = (async () => {
      const query = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
      if (!query) return [];
      const fonts = await query();
      return [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b, "pt-BR"));
    })();
    installed.catch(() => (installed = null));
  }
  return installed;
}

let catalog: Promise<{ family: string; category: string; popularity: number }[]> | null = null;

/** The whole Google Fonts catalog (Latin families), most popular first. */
export function googleCatalog() {
  if (!catalog) {
    catalog = window.api.googleFontsCatalog();
    catalog.catch(() => (catalog = null));
  }
  return catalog;
}

/** Load every non-system font the project's text uses; failures (offline, missing file) fall back to system fonts. */
export async function ensureProjectFonts(project: Project): Promise<void> {
  const styles = project.tracks.flatMap((t) => t.segments.map((s) => s.text)).filter((t): t is NonNullable<typeof t> => Boolean(t));
  if (styles.some((t) => t.fontSource === "custom")) await loadCustomFonts().catch(() => []);
  // Projects from before font sources were recorded only used the curated Google list.
  const google = new Set(styles.filter((t) => t.fontSource === "google" || (!t.fontSource && GOOGLE_FONTS.includes(t.fontFamily))).map((t) => t.fontFamily));
  await Promise.allSettled([...google].map(loadGoogleFont));
}
