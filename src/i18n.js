// The languages every user-facing text is written in. Gladys shows the
// reader's language and falls back to `en` for any other, so `en` stays first
// and every `{ en, fr, de, es }` object carries all four.

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

/** A language this integration writes in, or `en` for anything else. */
export function pickLanguage(value) {
  return LANGUAGES.includes(value) ? value : 'en';
}

/**
 * One text per language, built by `build(language)`.
 * @param {(language: string) => string} build
 * @returns {{ en: string, fr: string, de: string, es: string }}
 */
export function eachLanguage(build) {
  return Object.fromEntries(LANGUAGES.map((language) => [language, build(language)]));
}
