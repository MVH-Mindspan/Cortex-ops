import { Fragment } from "react";
import { DropdownMenu } from "radix-ui";
import {
  READING_PREFERENCES_COPY,
  readingPreferencesSummary
} from "@/lib/copy";
import type { ReadingPreferences } from "@/lib/reading-preferences";
import { CheckIcon, ChevronDownIcon, SlidersIcon } from "@/components/icons";

const FIELDS = ["length", "familiarity"] as const;

// Composer-toolbar control for the answer style. One chip shows the current
// choice; the menu holds both radio groups and the hint. Built on the Radix
// dropdown like ReachOutMenu, so arrow keys, focus return, Escape and
// outside-click dismissal come for free. Selecting an item keeps the menu
// open (two settings, one visit) — the chip text updating beneath it is the
// receipt.
export function ReadingPreferencesMenu({
  value,
  onChange
}: {
  value: ReadingPreferences;
  onChange: (value: ReadingPreferences) => void;
}) {
  const summary = readingPreferencesSummary(value);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`${READING_PREFERENCES_COPY.menuLabel}: ${summary}`}
          className="pressable flex h-7 shrink-0 items-center gap-1.5 rounded-[6px] border px-2 text-[13px] whitespace-nowrap text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
        >
          <SlidersIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="max-[560px]:hidden">{summary}</span>
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="end"
          sideOffset={6}
          className="animate-in fade-in zoom-in-95 slide-in-from-bottom-1 duration-200 ease-out-quart z-50 w-[240px] origin-bottom-right rounded-[10px] border bg-popover p-1.5 shadow-xl outline-none"
        >
          {FIELDS.map((field, index) => (
            <Fragment key={field}>
              {index > 0 && (
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
              )}
              <DropdownMenu.Label className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted-foreground">
                {READING_PREFERENCES_COPY[field].label}
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={value[field]}
                onValueChange={(next) => onChange({ ...value, [field]: next })}
              >
                {READING_PREFERENCES_COPY[field].options.map((option) => (
                  <DropdownMenu.RadioItem
                    key={option.value}
                    value={option.value}
                    onSelect={(event) => event.preventDefault()}
                    className="flex cursor-default items-center justify-between gap-3 rounded-[6px] px-2.5 py-1.5 text-[14px] text-foreground outline-none data-[highlighted]:bg-accent"
                  >
                    {option.label}
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon className="h-3.5 w-3.5" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </Fragment>
          ))}
          <p className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted-foreground/70">
            {READING_PREFERENCES_COPY.hint}
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
