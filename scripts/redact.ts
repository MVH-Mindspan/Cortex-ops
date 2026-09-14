// Notion quotes the id of the page or block that failed in its error text.
// The exports run in a workflow whose logs are public, so ids are stripped
// before any error reaches them (dashed and undashed, both forms Notion
// returns). Pure module, shared by export-sops.ts and export-personas.ts.
export function redactIds(message: string): string {
  return message.replace(
    /[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    "<id>"
  );
}
