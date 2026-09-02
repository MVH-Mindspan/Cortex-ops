// Deep link from another Mindspan app (docs/deeplink.md, contract v1):
//   /?v=1&action=ask|draft&q=<text>&src=<slug>&ref=<id>
// Pure and total: it runs at module scope in app.tsx before React mounts, so
// it must never throw on malformed input. Decoding is URLSearchParams only —
// form encoding (+ is a space, %0A a newline), decoded exactly once; a
// malformed percent sequence becomes U+FFFD rather than an exception.

export type DeepLinkAction = "ask" | "draft";
export type DeepLink = {
  action: DeepLinkAction;
  text: string;
  src: string | null;
  ref: string | null;
};

export const DEEP_LINK_VERSION = "1";
const SRC_RE = /^[a-z0-9-]{1,16}$/;
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Any v at all: the URL is stripped even when the link is not honoured, so a
// stale or unknown-version link can never re-fire on a reload.
export function hasDeepLinkParams(search: string): boolean {
  return new URLSearchParams(search).has("v");
}

export function parseDeepLink(
  search: string,
  maxChars: number
): DeepLink | null {
  const params = new URLSearchParams(search);
  if (params.get("v") !== DEEP_LINK_VERSION) return null;
  const text = (params.get("q") ?? "").replace(/\r\n?/g, "\n").trim();
  // Empty after trim, or a replacement character from a malformed percent
  // sequence: a plain visit, never a prefilled (let alone sent) garbage line.
  if (!text || text.includes("�")) return null;
  // Over the message cap the link still lands, as a draft the person can
  // trim: the textarea's maxLength does not clip a programmatic value.
  const action: DeepLinkAction =
    params.get("action") === "ask" && text.length <= maxChars ? "ask" : "draft";
  const src = params.get("src");
  const ref = params.get("ref");
  return {
    action,
    text,
    src: src && SRC_RE.test(src) ? src : null,
    ref: ref && REF_RE.test(ref) ? ref : null
  };
}
