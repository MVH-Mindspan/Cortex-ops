import "./styles.css";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { LogoMark } from "@/components/icons";

// Temporary diagnostic: paint any uncaught error onto the page so a blank
// screen explains itself (no error-reporting service in this prototype).
function showFatal(message: string) {
  const el = document.createElement("pre");
  el.style.cssText =
    "position:fixed;inset:16px;z-index:9999;overflow:auto;white-space:pre-wrap;" +
    "background:#262523;color:#f4f2ee;border:1px solid #e5484d;border-radius:12px;" +
    "padding:16px;font-size:13px;line-height:1.5;";
  el.textContent = `Cortex failed to start\n\n${message}`;
  document.body.appendChild(el);
}

window.addEventListener("error", (event) => {
  showFatal(String(event.error?.stack ?? event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  showFatal(
    `Unhandled rejection: ${String(event.reason?.stack ?? event.reason)}`
  );
});

try {
  const root = createRoot(document.getElementById("root")!);
  // useAgentChat suspends on its initial-messages fetch (React use()), so a
  // Suspense boundary above App is required — the upstream starter had one.
  // The fallback is delayed 150ms (fill-mode-backwards holds it invisible)
  // so a fast boot never flashes the mark.
  root.render(
    <Suspense
      fallback={
        <div className="animate-in fade-in fill-mode-backwards delay-150 duration-300 flex h-full items-center justify-center">
          <LogoMark className="animate-thinking h-6 w-6 text-brand-orange" />
        </div>
      }
    >
      <App />
    </Suspense>
  );
  // A quiet hello for whoever opens the console.
  console.log(
    "%cCortex — Mindspan operations advisor%c\n\n" +
      "Every answer is grounded in the team's SOPs: Notion → R2 → AI Search → llama-3.3-70b.\n" +
      "No patient identifiers in here, please — the screens run on every message, including yours.\n" +
      "Found a bug? Reach out (top right) goes straight to the admin.",
    "color:#c93a0e;font-family:Georgia,serif;font-size:14px;",
    "color:inherit;font-family:inherit;font-size:inherit;"
  );
} catch (err) {
  showFatal(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
