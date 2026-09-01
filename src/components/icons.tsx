// Tiny inline icon set — hand-drawn 16px strokes so no icon dependency is
// needed. All inherit currentColor.

type IconProps = { className?: string };

function base(props: IconProps) {
  return {
    className: props.className,
    width: 16,
    height: 16,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
  };
}

// The Cortex brand mark (public/cortex-mark.png) rendered through a CSS mask
// so it takes any color via currentColor — white in the header, brand orange
// as the accent glyph.
export function LogoMark({ className }: IconProps) {
  const mask = {
    maskImage: "url(/cortex-mark.png)",
    maskSize: "contain",
    maskRepeat: "no-repeat",
    maskPosition: "center",
    WebkitMaskImage: "url(/cortex-mark.png)",
    WebkitMaskSize: "contain",
    WebkitMaskRepeat: "no-repeat",
    WebkitMaskPosition: "center"
  } as const;
  return (
    <span
      aria-hidden="true"
      className={className}
      style={{
        display: "inline-block",
        backgroundColor: "currentColor",
        ...mask
      }}
    />
  );
}

export function SparkleIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      width="28"
      height="28"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M12 1.5 13.9 8.1 20.5 10 13.9 11.9 12 18.5 10.1 11.9 3.5 10 10.1 8.1 Z" />
      <path d="M18.8 15.2 19.6 17.9 22.3 18.7 19.6 19.5 18.8 22.2 18 19.5 15.3 18.7 18 17.9 Z" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" />
    </svg>
  );
}

export function LibraryIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <path d="M3 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 0-2-2H3Z" />
      <path d="M3 2.5v9M13.5 5v8.5" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5.5V8l1.8 1.3" />
    </svg>
  );
}

export function PinIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <path d="M9.5 2.5 13.5 6.5 12 8l-.5 3L8 11.5 4.5 8 5 4.5 8 4Z" />
      <path d="M8 11.5 3.5 13.5 5.5 9" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <path d="m13.5 13.5-3.2-3.2" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <path d="M8 1.8 13 3.6v4.2c0 3.2-2.1 5.3-5 6.4-2.9-1.1-5-3.2-5-6.4V3.6Z" />
    </svg>
  );
}

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <path d="M8 13V3.5M3.8 7.2 8 3l4.2 4.2" />
    </svg>
  );
}

export function StopIcon({ className }: IconProps) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1.5" />
    </svg>
  );
}

export function PanelIcon({ className }: IconProps) {
  return (
    <svg {...base({ className })} aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}
