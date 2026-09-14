// System prompt for the model patient-name screen (server.ts screenPII,
// llama-3.1-8b). Pure module so the staff exemption is unit-tested.
// Few-shot examples on purpose: llama-3.2-3b without them misclassified
// "My patient, Michael Van Havill" as clean.

const SCREEN_RULES = `You screen internal healthcare ops messages for patient privacy. Answer with exactly one word: yes or no.

Answer yes if the message contains a real personal human name (a first name, last name, or full name) of a patient, or of a patient's family member or caregiver — even when it appears alongside numbers, codes, facility names, or an MRN. A patient, chart, or record number by itself is not a name.

Answer no for everything else, including: names of staff or clinicians (Dr Musto, Taiye), hospital, clinic, university, facility, or company names (UCSF, LabCorp, Valley Radiology, the company Perry Health), system names (Athena; Mindy when it means the Mindspan task system, though "her daughter Mindy" is still a person), product, drug, order, result, protocol, or trial codes (TB006, Kisunla, Leqembi, IQLIK, Cryos), patient, chart, or record numbers (#313, MRN 4471902), and any message with no personal human name.`;

const SCREEN_EXAMPLES = `"My patient, John Smith, needs a refill" -> yes
"her husband Robert De Luca called twice" -> yes
"the patient Mary Alvarez is at the desk" -> yes
"#307 Robert Chen wants a callback about his results" -> yes
"her daughter Mindy missed the visit" -> yes
"Dr. Musto faxed the order to LabCorp" -> no
"#313 was on the schedule with Taiye yesterday" -> no
"a caregiver called asking to reschedule an infusion" -> no
"#301 wants their TB006 results sent to the UCSF consulting neurologist" -> no
"check Mindy completion status at T-7" -> no
"Mindy flagged #412 for an infusion check-in" -> no`;

// The prompt with no team directory loaded: what the screen has always used.
export const SCREEN_PROMPT = `${SCREEN_RULES}

Examples:
${SCREEN_EXAMPLES}`;

// The team directory puts staff names into routing questions ("should this
// go to <name>?"), which the screen would otherwise flag. The exemption is
// contextual, like Mindy's: the same name used for a patient or relative
// still answers yes. The names arrive from R2 at runtime (lib/personas.ts
// staffNames), so none is written here; the two added examples use one of
// them. With no names the prompt is SCREEN_PROMPT exactly.
export function buildScreenPrompt(staff: readonly string[]): string {
  const names = [
    ...new Set(staff.map((name) => name.replace(/\s+/g, " ").trim()))
  ].filter((name) => name.length > 0);
  if (names.length === 0) return SCREEN_PROMPT;
  // A bare first name makes the sharpest pair: the same word is staff in one
  // example and a patient in the other.
  const example =
    names.find((name) => !name.includes(" ")) ?? names[0].split(" ")[0];
  return `${SCREEN_RULES}

Mindspan staff on the team directory: ${names.join(", ")}. Answer no when one of these names is a staff member the message asks about, sends work to, asks, or escalates to. The same name used for a patient or a patient's family member or caregiver is still yes.

Examples:
${SCREEN_EXAMPLES}
"should this go to ${example} or to RCM?" -> no
"the patient ${example} Harper is at the desk" -> yes`;
}
