import { useId } from "react";
import { READING_PREFERENCES_COPY } from "@/lib/copy";
import type { ReadingPreferences } from "@/lib/reading-preferences";

export function ReadingPreferenceControls({
  value,
  onChange
}: {
  value: ReadingPreferences;
  onChange: (value: ReadingPreferences) => void;
}) {
  const id = useId();
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-x-6 gap-y-3">
        {(["length", "familiarity"] as const).map((field) => (
          <fieldset
            key={field}
            aria-describedby={`${id}-hint`}
            className="min-w-0"
          >
            <legend className="mb-1.5 text-[13px] text-muted-foreground">
              {READING_PREFERENCES_COPY[field].label}
            </legend>
            <div className="flex rounded-[8px] border bg-surface p-0.5">
              {READING_PREFERENCES_COPY[field].options.map((option) => (
                <label
                  key={option.value}
                  className="relative flex cursor-pointer"
                >
                  <input
                    type="radio"
                    name={`${id}-${field}`}
                    value={option.value}
                    checked={value[field] === option.value}
                    onChange={() =>
                      onChange({ ...value, [field]: option.value })
                    }
                    className="peer sr-only"
                  />
                  <span className="flex min-h-11 items-center rounded-[5px] border border-transparent px-3 text-[13px] text-muted-foreground hover:text-foreground peer-checked:border-muted-foreground/50 peer-checked:bg-accent peer-checked:text-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-foreground">
                    {option.label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
      <p
        id={`${id}-hint`}
        className="mt-2 text-[12px] leading-snug text-muted-foreground"
      >
        {READING_PREFERENCES_COPY.hint}
      </p>
    </div>
  );
}
