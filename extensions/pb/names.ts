/**
 * The one rule for names that become paths: spec folders and archived spec names.
 * Lowercase kebab-case, no separators or traversal, short enough to stay readable.
 */
export const KEBAB_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
