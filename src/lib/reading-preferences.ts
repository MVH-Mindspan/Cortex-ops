export type ReadingPreferences = {
  length: "concise" | "detailed";
  familiarity: "new" | "experienced";
};

export const DEFAULT_READING_PREFERENCES: Readonly<ReadingPreferences> = {
  length: "detailed",
  familiarity: "new"
};

export const READING_PREFERENCES_KEY = "cortex-reading-preferences";

// Only enum values reach the prompt. Old clients and corrupt storage use
// defaults independently for each field; arbitrary text is never interpolated.
export function normalizeReadingPreferences(
  value: unknown
): ReadingPreferences {
  const candidate =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Partial<ReadingPreferences>)
      : {};
  return {
    length: candidate.length === "concise" ? "concise" : "detailed",
    familiarity: candidate.familiarity === "experienced" ? "experienced" : "new"
  };
}

export function loadReadingPreferences(): ReadingPreferences {
  try {
    return normalizeReadingPreferences(
      JSON.parse(localStorage.getItem(READING_PREFERENCES_KEY) ?? "null")
    );
  } catch {
    return { ...DEFAULT_READING_PREFERENCES };
  }
}

export function saveReadingPreferences(preferences: ReadingPreferences): void {
  try {
    localStorage.setItem(
      READING_PREFERENCES_KEY,
      JSON.stringify(normalizeReadingPreferences(preferences))
    );
  } catch {
    // The in-memory selection still works when storage is unavailable.
  }
}

// Call before async screening: a new object pins the style to this submission.
export function readingPreferenceMetadata(
  preferences: ReadingPreferences,
  override?: boolean
) {
  return {
    readingPreferences: normalizeReadingPreferences(preferences),
    ...(override ? { override: true } : {})
  };
}
