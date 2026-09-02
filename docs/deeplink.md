# Cortex deep links (contract v1)

Other Mindspan apps can open Cortex with a situation already in the composer and, on request, already sent. This is Part A of the Orchestration Manager design spec "Ask Cortex Deep Link" (2026-09-02, contract version 1), the hand-off to Cortex, with the deviations made while implementing applied in place and listed in the Verification record at the end. The `src/lib/deeplink.ts` block under A8 is the shipped file.

## A1. Contract

```
https://cortex.mvh-9c9.workers.dev/?v=1&action=ask&q=<message>&src=om&ref=<caller-id>
```

The only supported origin is `https://cortex.mvh-9c9.workers.dev`. Callers never link to Cortex preview hostnames. The contract lives on `/` with query parameters, not on a dedicated path: the Worker only runs for `/agents/*` (`wrangler.jsonc` `run_worker_first`), every page path is served by the assets layer with `not_found_handling: single-page-application`, so a `/ask` path would serve the same bundle and only add a second thing to keep in sync.

## A2. Parameters

| Param    | Required | Value                                                                                                                                                                                                                                                                                                                                         | Cortex behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`      | yes      | `1`                                                                                                                                                                                                                                                                                                                                           | Absent or unknown → plain visit. Any `v` at all still triggers the URL strip (A3), so a stale or unknown-version link cannot re-fire later.                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `q`      | yes      | The situation text. `application/x-www-form-urlencoded` as produced by `URLSearchParams` (`+` is a space, `%0A` is a newline). Callers cap it at 1,500 characters, aim for 500–900, and keep the whole URL under 4 KB (an interactive Cloudflare Access login re-encodes the original URL into its `redirect_url`, so `%XX` becomes `%25XX`). | Decode with `URLSearchParams` (never `decodeURIComponent`, which throws on malformed sequences). Normalise CRLF to LF and trim. Empty after trim → plain visit. If `q` repeats, the first wins. Longer than `MAX_MESSAGE_CHARS` (8,000) → `action` is downgraded to `draft` and the text is kept intact; the textarea's `maxLength` does not clip a programmatic value, so the amber counter lets the person trim it, and Enter and Send stay inert (the button greys out) until it is under the cap. Malformed percent-encoding (a U+FFFD replacement character in the decoded text) → plain visit. |
| `action` | no       | `ask` or `draft`. Absent or any other value → `draft`.                                                                                                                                                                                                                                                                                        | `ask`: prefill, resize, focus, then run the ordinary `submit()` exactly as if the person had pressed Send. `draft`: prefill, resize, focus; Cortex's existing 350 ms pre-send warning applies to the prefilled text.                                                                                                                                                                                                                                                                                                                                                                                 |
| `src`    | no       | Slug of the calling app, `^[a-z0-9-]{1,16}$`. The Orchestration Manager sends `om`.                                                                                                                                                                                                                                                           | Validated; dropped silently if invalid. v1 Cortex accepts it and renders nothing from it. A `src`-keyed return-link template is a v2 item. There is never a free-form return-URL parameter (open-redirect surface).                                                                                                                                                                                                                                                                                                                                                                                  |
| `ref`    | no       | Opaque caller reference, `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$` (a task id).                                                                                                                                                                                                                                                                      | Validated; dropped silently if invalid. Never inserted into the message text. Two clicks on the same task create two threads; `ref` does not dedupe.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Unknown parameters are ignored.

## A3. Receiver lifecycle rules

Each rule is tied to the code as it stands at `Cortex-ops` main `b045919` (2026-09-02). Line references are to that pre-feature commit; they shift once the receiver lands.

1. **Parse once, at module scope.** Next to `initialThreadId` (`app.tsx` ~362–367). That constant exists because a suspended first mount is discarded and replayed and `useState` initializers run again on replay; the deep link has the same hazard.
2. **Strip the URL immediately, at module scope, whenever `v` is present.** `history.replaceState(null, "", window.location.pathname)`, writing back only the pathname so nothing derived from the parameters is echoed into the address bar or history. Module scope in `app.tsx` runs during `client.tsx`'s import, before `createRoot`, which closes the window in which a reload during the Suspense fallback would re-send.
3. **Consume exactly once from an effect, never from render or a state initializer.** A module-level `consumed` flag, read from a mount-only `useEffect` inside `Conversation`. `Conversation` is keyed by `${threadId}:${threadEpoch}` (`app.tsx` ~1555) and remounts on New situation, Open recent, and the stale-tab epoch bump after an hour hidden (`app.tsx` ~1126–1141); a flag held in React state would reset on each remount and re-send.
4. **Seed the composer from the module constant.** `App` initialises `input` with `pendingDeepLink?.text ?? ""` (idempotent on replay). `Conversation`'s effect runs only after `useAgentChat` has resolved and the first render has committed, so `submit` already closes over the prefilled `input`, a live `agent` and `sendMessage`.
5. **Never bypass the screens.** `submit()` (`app.tsx` ~838–905) runs the gratitude intercept, the `checkPHI` hard tripwire, the model name screen with its 8 s fail-open timeout, then `sendMessage`. The server backstop in `onChatMessage` (`server.ts` ~257–285) and `sanitizeMessageForPersistence` are unchanged. No automatic break-glass.
6. **Exception-safe.** `client.tsx` (~19–26) turns any uncaught error or unhandled rejection into a full-screen "Cortex failed to start" overlay. The effect wraps its body in try/catch and calls `submit().catch(() => {})`, so a failed auto-send degrades to "prefilled, not sent" with the text retained. `parseDeepLink` is total: it never throws on malformed input, because it runs before React mounts.
7. **Prerender guard.** If `document.prerendering` is true, wait for `prerenderingchange` before running, so a hidden prerender never spends a message or writes a recents entry. Callers must not attach prefetch, prerender or speculation hints to the link.
8. **Fresh thread.** A page load already mints a new `initialThreadId`; the deep link never joins an existing conversation.
9. **Recents.** The entry title is the first non-empty line of the first message, up to 48 characters (`recentTitle` in `src/lib/copy.ts`, applied in the recents effect in `app.tsx`). Callers therefore lead with a meaningful first line. The rule applies to typed messages too; entries already stored keep their earlier title.
10. **Nothing from `q` is logged** and nothing from it is added to AI Gateway metadata. The static request for `/` never invokes Worker code, so the query string cannot reach Workers Logs. On `ask` the text itself then follows the ordinary message path (client screen, Durable Object persistence, server backstop, retrieval, generation, the 7-day purge), exactly as if it had been typed. The answer pipeline's catch logs provider errors as text (stack or message), never the raw error object, which can carry the request payload.
11. **Honest UX.** On `ask`, the person sees the empty-state layout with the prefilled composer and the "Checking for patient names" indicator for roughly 0.5–3 s, then the conversation layout with their bubble and the retrieval lines. That is what a human sees pressing Send on a quick-start. Optional refinement: an `autosending` state folded into `hasConversation` so the page starts in the docked layout. Do not build an optimistic user bubble; it duplicates on the server echo.
12. **Socket timing.** `useAgentChat` suspends on the initial-messages fetch, not on socket open, so the effect may fire while the socket is still connecting. Outbound frames queue until open, and the 8 s fail-open plus the server backstop cover a socket that never opens. Net effect: at worst delayed, never lost or duplicated. Verify once with the Network tab.

## A4. Expected outcomes

- **Name-screen false positive.** The message stays in the composer with the standard "Message blocked" alert and the existing "Confirm no PII included" button (`app.tsx` ~1028–1047). One click sends with `metadata.override`, which skips only the probabilistic screen. This is the intended path for an `ask` link.
- **Hard identifier** (SSN, email, phone, DOB near a date). Blocked; text kept; the person must edit. Not overridable.
- **`BUDGET_PAUSED_LINE`** and **`NO_MATCH_LINE`** are normal responses and need no special handling.
- **Over-length `q`** lands as a draft with the amber counter.
- **Cold session.** Cloudflare Access redirects to login and returns to the original URL with the query string intact, so the prefill and send survive. (Fragments would not survive an interactive IdP login, which is why the contract uses the query string.) Verify in a private window.

## A5. Security and privacy

- **One-click GET with side effects.** Any Access-authenticated person who clicks a pasted Ask-Cortex link auto-sends one message. From the code, one click costs: two name-screen passes (client pre-send and server backstop), each one small-model call for text under 2,000 characters and roughly one more per further 1,800 characters, run in parallel; one persisted user row in a new per-thread Durable Object with a daily purge alarm held for at least 7 days; then one `UsageBudget` unit gating retrieval and generation. Bounded by Cloudflare Access (who can load the page), the AI Gateway dollar limit (both AI calls; AI Search sits outside it), prompt rule 11 (instructions inside messages are ignored), the absence of tools, and the fact that `q` renders as a React text node (no XSS). **Accepted residual risk for v1.** The monthly message budget is a single team-global counter consumed after the screens and the row, so it bounds abuse only by pausing answers for the whole team; consuming it before the backstop screen is the cheapest v2 tightening. Other v2 options if abuse or a log-exposure requirement appears: carry `q` in the fragment, gate `ask` on a signed `t=` token (HMAC over `q`+`ref` with a key shared by the two apps), or a per-`src` referrer allow-list.
- **Why no referrer gate now.** The Orchestration Manager has no stable origin (Vercel previews, GitHub Pages under a base path, localhost), so an allow-list would silently downgrade every unlisted click. Callers keep `rel="noopener noreferrer"`.
- **Log surfaces.** The query never reaches Worker code. Cloudflare Access may record the URL on a login event; zone analytics may record it if ever enabled. Acceptable because `q` is identifier-free by construction on the caller's side (Part B) and tested against a vendored copy of `checkPHI`/`checkPossiblePII`. The address bar is clean from the first frame (A3.2), so bookmarks, tab duplication and referrers carry nothing.
- **Persistence.** The message is persisted through the normal path and purged by the 7-day schedule. Recents titles (the first non-empty line, up to 48 characters) sit in localStorage on the device.
- **No return URL parameter, ever.** If a return link is wanted later, Cortex builds it from a template it owns, keyed by `src`.
- **Preview hostnames.** `wrangler.jsonc` sets neither `workers_dev` nor `preview_urls`, so branch previews exist and would honour the same link. Acceptance item: confirm previews are challenged by Access, or set `preview_urls: false`. Verified 2026-09-02: they are challenged (see the Verification record), so `preview_urls` stays unset.

## A6. Compatibility and rollout

- Cortex ships first. Against today's Cortex, a deep link lands on a plain page with the parameters visible in the address bar and nothing happens; callers hold their PR until the receiver is deployed.
- Any recognised `v` triggers the strip even when the version is unknown. Unknown `action` → draft. Invalid `src`/`ref` → dropped, never fatal.
- Adding parameters is non-breaking. Changing the meaning of `q` or `action` bumps `v`.

## A7. Example

Fixture message (M001, an unclaimed caregiver-coordination task; 596 characters; verified `checkPHI().blocked === false` and `checkPossiblePII() === null` against `phi.ts` at `efa253d`):

```
Caregiver Required: confirm caregiver attendance for a Cognitive Assessment (99483) visit in 7 days.
This task is unclaimed and I am deciding whether to pick it up. In Orchestration Manager it sits with the Member Experience team as Caregiver Liaison, on the Cognitive pathway, core protocol. It was flagged as 'Protocol step missing' by Cognitive Visit Protocol — Phase 2 Readiness Checklist. The visit is a Cognitive Assessment (99483) in 7 days. The caregiver contact status is pending. It is pending, high priority, due in 6 days.
What are the steps to complete this task, and who handles it?
```

Encoded URL (703 characters; `new URLSearchParams(new URL(url).search).get("q")` returns the fixture exactly):

```
https://cortex.mvh-9c9.workers.dev/?v=1&action=ask&q=Caregiver+Required%3A+confirm+caregiver+attendance+for+a+Cognitive+Assessment+%2899483%29+visit+in+7+days.%0AThis+task+is+unclaimed+and+I+am+deciding+whether+to+pick+it+up.+In+Orchestration+Manager+it+sits+with+the+Member+Experience+team+as+Caregiver+Liaison%2C+on+the+Cognitive+pathway%2C+core+protocol.+It+was+flagged+as+%27Protocol+step+missing%27+by+Cognitive+Visit+Protocol+%E2%80%94+Phase+2+Readiness+Checklist.+The+visit+is+a+Cognitive+Assessment+%2899483%29+in+7+days.+The+caregiver+contact+status+is+pending.+It+is+pending%2C+high+priority%2C+due+in+6+days.%0AWhat+are+the+steps+to+complete+this+task%2C+and+who+handles+it%3F&src=om&ref=M001
```

Recents label for this message: `Caregiver Required: confirm caregiver attendance`.

## A8. Cortex implementation notes

Files: new `src/lib/deeplink.ts` (pure), new `src/lib/deeplink.test.ts` (`node --test`, picked up by `npm run check`), about 80 lines in `src/app.tsx`, a few lines in `src/server.ts` (`SCREEN_PROMPT`, and the answer pipeline's catch logging provider errors as text), `src/lib/copy.ts` and `src/lib/copy.test.ts` (`recentTitle`), and `src/lib/phi.test.ts`. No changes to `wrangler.jsonc`, `client.tsx` or `phi.ts`. House style: oxfmt (double quotes, no trailing commas), oxlint, TypeScript 6, `.ts` extensions on value imports between `src/lib` modules.

`src/lib/deeplink.ts`:

```ts
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
```

`src/app.tsx`, module scope next to `initialThreadId`:

```ts
import {
  hasDeepLinkParams,
  parseDeepLink,
  type DeepLink
} from "@/lib/deeplink";

// Read and stripped from the URL once, at module scope, for the same reason as
// initialThreadId: render and state initializers can be replayed. Consumed
// exactly once from an effect (below), so thread switches and the stale-tab
// remount never re-send. The try/catch is load-bearing: client.tsx installs
// its error overlay only after this module has evaluated.
const pendingDeepLink: DeepLink | null = (() => {
  try {
    if (typeof window === "undefined") return null;
    const { search, pathname } = window.location;
    if (!hasDeepLinkParams(search)) return null;
    const link = parseDeepLink(search, MAX_MESSAGE_CHARS);
    history.replaceState(null, "", pathname);
    return link;
  } catch {
    return null;
  }
})();
let deepLinkConsumed = false;
function takeDeepLink(): DeepLink | null {
  if (deepLinkConsumed) return null;
  deepLinkConsumed = true;
  return pendingDeepLink;
}
```

`App`: `const [input, setInput] = useState<string>(() => pendingDeepLink?.text ?? "");` (do not call `takeDeepLink` here).

`Conversation`, after `submit` is defined and before `composer`:

```ts
// Deep-link intent, consumed after the first committed render: by then
// useAgentChat has resolved and `submit` closes over the prefilled input and a
// live agent. Exception-safe so a failure never reaches the fatal overlay in
// client.tsx; waits out a prerender so a hidden document never spends a message.
useEffect(() => {
  if (!pendingDeepLink || deepLinkConsumed) return;
  const run = () => {
    const link = takeDeepLink(); // burned only by the invocation that runs
    if (!link) return;
    try {
      resizeComposer();
      textareaRef.current?.focus();
      if (link.action === "ask") submit().catch(() => {});
    } catch {
      // leave the text in the composer
    }
  };
  const doc = document as Document & { prerendering?: boolean };
  if (!doc.prerendering) {
    run();
    return;
  }
  doc.addEventListener("prerenderingchange", run, { once: true });
  return () => doc.removeEventListener("prerenderingchange", run);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
```

`submit`'s own guards (`!text || text.length > MAX_MESSAGE_CHARS || isStreaming || screening`) hold on mount. Focusing before submit sets `composerHadFocusRef`, so focus returns to the docked composer after the layout switch.

`src/server.ts`, `SCREEN_PROMPT`: teach the screen the Mindspan vocabulary in context rather than as a blanket exemption, because a false positive is recoverable (the break-glass button) and a false negative is not (`checkPHI` has no name rule, and the soft screen only catches a relation word followed by a capitalised full name). The "no" sentence names Mindy as the Mindspan task system next to Athena, with the caveat in the same clause that "her daughter Mindy" is still a person; adds "the company Perry Health" to the company names; and adds Kisunla, Leqembi, IQLIK and Cryos to the product and drug codes. Paired examples fix the boundary: `"check Mindy completion status at T-7" -> no`, `"Mindy flagged #412 for an infusion check-in" -> no` and `"her daughter Mindy missed the visit" -> yes`. Without this, simulator tasks whose canonical descriptions mention Mindy risk a false block on every `ask`.

`src/lib/deeplink.test.ts` cases: `v` missing → null; `v=2` → null; `q` missing or whitespace → null; `q=a+b%0Ac` → `"a b\nc"`; `a%0D%0Ab` and `a%0Db` → `"a\nb"`; a bare `%0D%0A` → null; `action` absent → draft; `ask` → ask; `bogus` → draft; `ask` with `text.length === maxChars` → ask and `maxChars + 1` → draft with text intact; `src` `om` kept, `OM` and `a b` dropped; `ref` `M001` and `SIM-99205-004` kept, 65 chars or `..` or `/` dropped; unknown params ignored; repeated `q` takes the first; `hasDeepLinkParams` true for `?v=9`, false for `?foo=1`; garbage `?v=1&q=%E0%A4%A` does not throw and returns null (a replacement character marks a malformed link: plain visit); `q=a%252Bb` → `"a%2Bb"` (decoded once); the A7 URL parses to the A7 fixture with `src` `om` and `ref` `M001`.

`src/lib/phi.test.ts`: add the A7 fixture string as `OM_SAMPLE_M001` asserting `checkPHI(...).blocked === false` and `checkPossiblePII(...) === null`, plus a negative control (`"My patient Margaret Chen is asking about her visit."` → soft `"a patient name"`) so the fixture is proven to exercise the screens. This is the drift guard between the two repos.

## A9. Acceptance checklist

1. Paste the A7 URL in a warm session: composer prefilled, screening indicator, then bubble and SOP cards; address bar shows `/`.
2. Same URL in a private window (cold Access session): login round-trip, then the same result. Confirms the query string survives Access.
3. Reload after landing: no second send; one recents entry.
4. `action=draft`: prefilled and focused, not sent; pre-send warnings behave as for typed text.
5. `action=bogus` and `action` absent: draft.
6. `v=2`: plain visit, URL stripped.
7. `q` of 8,001 characters: draft, text intact, amber counter; Enter does nothing and the Send button is greyed out until the text is trimmed.
8. `q` containing `DOB 04/12/1941`: blocked alert, text retained, no override button.
9. `q=%E0%A4%A`: no crash, plain visit.
10. New situation, Open recent, and tab hidden more than an hour (temporarily lower `STALE_TAB_MS`): no re-send.
11. A branch preview hostname in a private window is challenged by Cloudflare Access, or `preview_urls` is set to false. (Verified 2026-09-02; see the Verification record.)
12. `npm run check` is green with the deeplink tests and the phi fixture.

## Verification record

- 2026-09-02, preview hostnames (A5, A9.11): `https://cortex.mvh-9c9.workers.dev/?v=1&q=hello`, `https://abcd1234-cortex.mvh-9c9.workers.dev/` (version-style alias) and `https://tianjin-v1-cortex.mvh-9c9.workers.dev/` (branch-style alias) each answered `302` to `https://mvh-9c9.cloudflareaccess.com/cdn-cgi/access/login/<that hostname>`, with `redirect_url` preserving the query string. Preview hostnames are behind Access, so `preview_urls` stays unset and Workers Builds branch previews remain available for QA.
- 2026-09-02, local headless QA on `vite dev` with the AI, AI Search and remote R2 bindings removed (the screens fail open and retrieval returns its error line): A9.3–10 all behaved as written, including reload, New situation then Open recent, the 8,001-character draft with an inert Send, the DOB block without an override button, and the malformed-encoding plain visit. The Vite Cloudflare plugin's local trace store showed Worker invocations only for `/agents/*`, with no span or log line containing the query string or the message text. A9.1–2 (live URL, cold Access session) and the Workers Logs check below are pending the production deploy.
- 2026-09-02, name-screen prompt (A8): the committed prompt and the new one were run against `@cf/meta/llama-3.1-8b-instruct-fast` (temperature 0) from a throwaway `wrangler dev --remote` probe on 22 sentences: the eight examples from the prompt, seven relation-word sentences with Mindy, Perry or Robert as a person, five sentences with Mindy, Perry Health, Cryos, IQLIK or Leqembi as systems or products, and the B6 CENP-004 and A7 M001 messages. Every prompt variant screened all thirteen person sentences as names (no false negatives in three runs). The shipped prompt misclassified one system sentence ("the Mindy reminder for #118 has not gone out yet") as a name, against two for the committed prompt; such misses are recoverable through the break-glass button, and borderline "Mindy as the sentence's agent" cases flip between runs. CENP-004 and M001 passed every time.
- The "query string never reaches Worker code" invariant (A3.10) rests on the built `index.html` sitting at the assets root (Vite's Cloudflare plugin writes the deploy config; `public/` alone holds only images), not on `run_worker_first` alone. After a deploy, load the live URL with a distinctive `q` and confirm Workers Logs record no invocation for that request.
- Deviations from the spec as first written, all applied above: malformed percent-encoding is a plain visit (A2, A8, A9.9); over-cap text cannot be sent until trimmed and the Send button greys out (A2, A9.7); the CRLF test cases (A8); recents titled from the first non-empty line, for typed messages too (A3.9, A5); the name-screen wording made contextual with paired examples and checked against the screen model (A8); the cost and abuse sentence restated from the code (A5); the privacy wording qualified — the query string never reaches the Worker, the text on `ask` follows the ordinary message path (A3.10); provider errors logged as text rather than the raw object (A3.10, A8); the module-scope parse wrapped in try/catch and the effect burning its flag only when it runs (A8).
