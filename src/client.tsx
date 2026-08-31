import "./styles.css";
import { Suspense } from "react";
import { createRoot } from "react-dom/client";
import App from "./app";

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
  root.render(
    <Suspense fallback={null}>
      <App />
    </Suspense>
  );
} catch (err) {
  showFatal(err instanceof Error ? (err.stack ?? err.message) : String(err));
}
