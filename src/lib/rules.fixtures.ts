// Verbatim excerpts of real Mindspan SOPs, taken from the read-only Notion
// export of 3 September 2026, with YAML frontmatter stripped. Each source
// file's DRAFT banner is replaced with a synthetic one, because the real
// banners name Slack channels; nothing else is edited, so the list items keep
// the one-item-per-physical-line shape the extractor relies on.
//
// Fixtures carry no staff names, no Slack channels and no drafting
// attributions: where the source SOP named a person, this file names the role
// instead, so a test failure can be pasted anywhere without leaking who works
// on what.
//
// This is deliberately not a *.test.ts file: the `node --test` glob and the
// formatter both leave the passage text alone here.

// Imaging Order Requirements — Amyloid PET & MRI Checklist. Carries the rule
// the tester saw the model drop: a prohibition buried in a parenthetical.
export const IMAGING_SOP = `> 🚧 **DRAFT — NEEDS REVIEW.** Test fixture.

This SOP is a pre-send checklist for imaging orders so facilities can schedule on first receipt instead of calling back. Every callback costs days of patient delay and an ops phone cycle.


## 📋 Document Info


| Field            | Value                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Owner**        | TBD — assign at review                                                                                                                                 |
| **Version**      | 0.1 (draft)                                                                                                                                            |
| **Status**       | Needs review                                                                                                                                           |
| **Related SOPs** | 🧭 Misrouted & Missing Orders, 🛡️ Insurance Verification & Prior Authorization, [Untitled](https://app.notion.com/p/3cab5943d52d81fa8c12f095d7b8710d) |


## Amyloid PET orders — required before sending

1. **Exact study name**: "PET CT amyloid brain scan" — facilities reject "PET brain" as insufficient.
2. **Medicare-covered ICD-10** on the order. Codes VRI has accepted: G31.84, R41.3, G30.0, G30.1, G30.9 — the prescriber selects the clinically correct one (ops never adds or changes codes; route to the provider per 🏥 External Facility & Provider Calls).
3. **Attachments**: most recent chart notes AND prior brain imaging reports (MRI). The provider's internal note does not transmit with the fax — attach explicitly (+ Attachments → Encounters and Procedures).
4. **Prior authorization confirmed** and the auth number transmitted with the order (see 🛡️ Insurance & PA; CED registry requirements for anti-amyloid therapy patients per the [Infusion Referral SOP](https://app.notion.com/p/353b5943d52d81f1af17debd6e76b7ef)).
5. If the patient is an anti-amyloid therapy candidate, say so — facilities ask and hold scheduling on the answer.

## MRI / MRA / CT orders

1. Exact study + laterality + with/without contrast as the note specifies; "MRA head and neck" is two orders if the facility treats them separately — confirm.
2. ICD-10 present; auth confirmed where the payer requires it (UMI holds MRIs waiting on auth; an auth without a matching order also blocks — both must exist and match).
3. Attach the most recent visit note; include prior imaging when the study is comparative.
4. Referral validity: facilities expire referrals — if scheduling slips past [90 days — confirm], re-issue rather than letting the patient be turned away with "referral expired."
5. Sedation/premed needs (anxious or cognitively impaired patients) noted on the order so the facility plans for it — premed prescriptions route to the prescriber first.

## Before faxing — final check

1. "Send to" facility correct and fax number verified.
2. Confirmation banner checked after sending; update the OE task: "Order faxed to <facility> <date>, confirmation banner verified. Facility to schedule; patient told to expect their call by <date>, callback path given."
3. Patient told which facility and that the facility will call to schedule — with a callback path if no contact within a week.

## ✅ Quick-Reference Checklist

- [ ] Exact study name (amyloid: "PET CT amyloid brain scan")
- [ ] Clinically correct Medicare-covered ICD-10, chosen by prescriber
- [ ] Notes + prior imaging attached explicitly
- [ ] Auth confirmed, number transmitted, order and auth match
- [ ] Referral/order not expired at time of scheduling
- [ ] Sedation needs flagged; premeds via prescriber
- [ ] Send-to verified, confirmation checked, patient informed`;

// External Facility & Provider Calls — Records, Re-Faxes, Code Fixes.
export const EXTERNAL_SOP = `> 🚧 **DRAFT — NEEDS REVIEW.** Test fixture.

This SOP covers inbound calls and faxes **from other facilities and providers**: a specialist's office requesting records, an imaging center asking for a re-fax of an order, a lab flagging a diagnosis-code problem, or a PCP office returning a records request. It begins with the inbound contact and ends when the request is fulfilled and logged in Athena.

## Process Steps


### Step 1. Verify the requester

1. Confirm the facility name, caller name, and callback number. For records requests, call back via the facility's publicly listed number if anything feels off — never release records based on caller ID alone.
2. Confirm the patient by name + DOB and that we actually have a treatment relationship.

### Step 2. Records requests (treatment purposes)

1. Provider-to-provider requests for treatment generally do not need a signed ROI — but confirm scope (which documents, which date range).
2. Send to a **verified fax number or Direct address only**; add a chart note: "Records sent to <facility/provider> at <verified fax # / Direct address> on <date>: <document list + date range>. Purpose: treatment. Requester verified via <callback to listed number / known contact>." Frequent-receiver fax numbers and provider NPIs are maintained in [📋 Managing the Clinical Inbox](https://app.notion.com/p/3acb5943d52d81e3b911d16e0c32aad9) — check there before hunting for a number, and note that outbound care summaries to PCPs already run on a next-day Tue/Wed/Fri Athena-fax cadence.
3. Anything beyond treatment purposes (attorney, insurer, employer) → route through the Patient Records Requests SOP (signed ROI required).

### Step 3. Re-fax requests

1. Locate the original order/referral in Athena; verify the "Send to" details.
2. Confirm the correct fax number with the caller **while on the phone**, re-send, and confirm receipt before ending the call.
3. If the number on file was wrong, fix the facility record in Athena so the next order doesn't repeat the failure — and note the fix.

### Step 4. Diagnosis / CPT code problems

1. Ops staff never change clinical or billing codes on their own.
2. Capture exactly what the facility says is wrong (claim/order number, code in question, what they say it should be).
3. Route to the provider for clinical codes, or the billing owner for CPT/claim issues, with the facility's callback details and a due date.
4. Confirm back to the facility once corrected and re-sent.

### Step 5. Log every call


Every external facility contact gets a chart note on the affected patient:

> **FACILITY CALL —** [facility], [caller name], [callback number]
> **Request:** re-fax / records request / code fix / other
> **Action:** [what you did, including anything re-sent + receipt confirmation]
> **Follow-up:** none / [action + owner + due date]

This is what makes repeat-failure patterns visible (see Misrouted & Missing Orders, Step 5).


## ✅ Quick-Reference Checklist

- [ ] Requester and patient verified before anything is released
- [ ] Treatment-purpose records sent to verified numbers only, scope confirmed
- [ ] Non-treatment requests routed to ROI process
- [ ] Re-faxes confirmed received while on the phone
- [ ] Incorrect fax numbers fixed in Athena at the source
- [ ] Code issues routed to provider/billing — never changed by ops
- [ ] Every contact logged in Athena`;

// Results & Next-Steps Requests.
export const RESULTS_SOP = `> 🚧 **DRAFT — NEEDS REVIEW.** Test fixture.

This SOP covers a patient or caregiver contacting us to ask about test results ("are my labs back?", "what did the MRI show?") or what happens next in their care. It defines what ops staff may share, what must come from a clinician, and how to avoid the worst failure mode: a patient learning significant news from a portal or an untrained reading of a report.

## Process Steps


### Step 1. Check the actual status in Athena


Before saying anything, look it up. Establish which of these is true:

1. **Not yet resulted** — order still open at the lab/imaging center. Set expectations accordingly: labs typically ~1 week; imaging reports routinely take 2–3 weeks.
2. **Resulted, not yet reviewed** by the provider.
3. **Resulted and reviewed/released** by the provider.

If the result should exist but doesn't, treat it as a possible routing failure (🧭 Misrouted & Missing Orders) — don't just tell the patient "not back yet."


### Step 2. What ops may share

- **Status and logistics, always**: "Your labs were drawn on the 12th; results usually take about a week"; "The MRI report is in and Dr. [Name] will review it before your visit on the 20th."
- **Reviewed-and-released results**: point the patient to the portal copy or send it per the records process — in the Perry app, Portal → **Distribute Results to Member Portal** or Send Message with attachment (see [Care Navigation Tools](https://app.notion.com/p/390b5943d52d81c59f97c4dbbce9bcba)); for sensitive results, offer a clinician call rather than reading anything aloud.
- **Never**: interpretation of an unreviewed result, reading values or impressions from a report the provider hasn't released, or reassurance/concern about what a result means.

### Step 3. Resulted but not reviewed

1. Tell the patient the result has arrived and the provider will review it; give a specific expectation (e.g., "you'll hear from us by [day]").
2. Flag the provider in Athena that the patient is asking — patient-initiated requests should pull review forward, especially if the next visit is far out. Results sit in the provider's own inbox for review; don't close them out on their behalf (see [📋 Managing the Clinical Inbox](https://app.notion.com/p/3acb5943d52d81e3b911d16e0c32aad9)).
3. If the provider's review surfaces something needing discussion, the clinician makes that call — ops schedules it.

### Step 4. "What happens next?" requests

1. Answer from the documented care plan: upcoming appointments, outstanding orders, referrals in flight (all visible in Athena/OE).
2. Questions about **why** a step matters or whether a plan should change → route to the care team as a routine clinical message (1-business-day response).

### Step 5. Document


Add a chart note: "Results inquiry from <name + relationship> on <date> re <test>. Status at time of call: <not resulted / resulted, unreviewed / released>. Shared with caller: <exactly what you said>. Committed: <e.g. provider flagged; patient expects update by <date>>." If the patient seemed anxious or confused, add a line for the care team — repeated results-anxiety is a signal the visit cadence or communication plan needs adjusting.


## ✅ Quick-Reference Checklist

- [ ] Result status verified in Athena before responding
- [ ] Missing-but-expected results treated as routing failures
- [ ] Only status/logistics shared for unreviewed results; no interpretation by ops
- [ ] Provider flagged when patients ask about unreviewed results
- [ ] Released results delivered via portal/records process; clinician call offered for sensitive news
- [ ] Next-steps answered from the documented plan only
- [ ] Request and response logged in Athena`;

// Negative: intake survey questions. "Can you dress yourself on your own?"
// reads like an autonomy rule to a lexicon that is too eager.
export const SURVEY_QUESTIONS = `## 📝 Full List of Intake Questions

- Do you drive at the moment?
- Do you have any worries about your driving?
- Who takes care of your bills and banking these days?
- How do you handle your medicines day to day?
- Can you make calls and send texts on your phone on your own?
- Can you use apps or a computer on your own?
- In the last while, have any of these happened?
- Can you dress yourself on your own?
- Can you use the bathroom on your own?
- Can you prepare meals or cook on your own?
- Is there anything else you need help with now that you used to do on your own?`;

// Negative: a task that "closes on its own" is a fact about automation, not a
// rule about who may act.
export const TASK_CLOSES_ON_ITS_OWN = `### Step 2. Verify Member Completed Remote Cognitive Screening

1. Verify the patient’s remote cognitive screening (MoCA) has been completed
2. This task is auto-completed — the MoCA is sent to the patient automatically, and once they complete it, the task closes on its own
3. If the patient tells you they completed the MoCA but the task is still active, create a **Subtask** for the backend owner to check the backend for a status update (e.g. the patient started the assessment but didn’t complete it, hasn’t started it, etc.)
4. If the patient declines to do the MoCA, or plans to complete in office, the task can be cancelled.
5. If the patient needs the MoCA resent, go to their profile in the **Perry App >> Actions >> Cognitive >> Send Link for AI avatar assisted Full MoCA and MIS Screening**. Confirm whether member wants this send via **email** or **text**, and verify the one we have on file is correct.
    - If member doesn’t have access to a smart phone or computer with a camera, select the option for **Send link for Full MoCA and MIS Screening**
<details>
<summary>🎨 Design Notes & ⚠️ Pitfalls</summary>

**Design Notes**`;
