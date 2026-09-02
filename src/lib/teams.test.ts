import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HANDOFFS,
  OUTSIDE_OPERATIONS,
  renderTeamStructure,
  TEAM_STRUCTURE_MAX_CHARS,
  TEAMS
} from "./teams.ts";

const rendered = renderTeamStructure();

// Every human-authored string in the directory, for the exclusion checks.
function dataStrings(): string[] {
  const out: string[] = [];
  for (const team of TEAMS) {
    out.push(team.name, team.purpose, team.route ?? "");
    for (const fn of team.functions) {
      out.push(fn.name, fn.covers, ...(fn.aliases ?? []));
    }
  }
  for (const handoff of HANDOFFS) out.push(handoff.when);
  for (const group of OUTSIDE_OPERATIONS) {
    out.push(group.name, group.covers, ...(group.aliases ?? []));
    out.push(group.contact.team, group.contact.fn);
  }
  return out.filter((s) => s.length > 0);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("renders every team header and function line once, in order", () => {
  let cursor = -1;
  for (const team of TEAMS) {
    const header = `${team.name} team: `;
    assert.equal(countOf(rendered, header), 1, header);
    const at = rendered.indexOf(header);
    assert.ok(at > cursor, `${team.name} out of order`);
    cursor = at;
    for (const fn of team.functions) {
      const line = `\n- ${fn.name}: `;
      assert.equal(countOf(rendered, line), 1, line);
      const fnAt = rendered.indexOf(line);
      assert.ok(fnAt > cursor, `${fn.name} out of order`);
      cursor = fnAt;
    }
  }
  for (const group of OUTSIDE_OPERATIONS) {
    assert.equal(countOf(rendered, `\n- ${group.name}: `), 1, group.name);
  }
});

test("renders the route only for teams that have one", () => {
  const withRoute = TEAMS.filter((team) => team.route);
  assert.equal(withRoute.length, 1);
  assert.equal(withRoute[0].name, "Care Support");
  assert.equal(countOf(rendered, "Route work through: "), 1);
  assert.match(
    rendered,
    /Care Support team: [^\n]* Route work through: Inbound Triage \(Zendesk\)\.\n/
  );
});

test("renders aliases only where a function has them", () => {
  const withAliases = TEAMS.flatMap((team) => team.functions).filter(
    (fn) => fn.aliases && fn.aliases.length > 0
  );
  const outsideWithAliases = OUTSIDE_OPERATIONS.filter(
    (group) => group.aliases && group.aliases.length > 0
  );
  assert.equal(
    countOf(rendered, " Also called: "),
    withAliases.length + outsideWithAliases.length
  );
  const recruiting = rendered.match(/\n- Recruiting: [^\n]*/)?.[0] ?? "";
  assert.ok(recruiting.length > 0);
  assert.doesNotMatch(recruiting, /Also called/);
  assert.match(
    rendered,
    /\n- Patient Support \(Enrollment & Member Experience\): [^\n]* Also called: Enrollment, /
  );
});

test("aliases are unique and never equal a team or function name", () => {
  const names = new Set<string>();
  for (const team of TEAMS) {
    names.add(team.name.toLowerCase());
    for (const fn of team.functions) names.add(fn.name.toLowerCase());
  }
  for (const group of OUTSIDE_OPERATIONS) names.add(group.name.toLowerCase());
  const aliases = [
    ...TEAMS.flatMap((team) =>
      team.functions.flatMap((fn) => fn.aliases ?? [])
    ),
    ...OUTSIDE_OPERATIONS.flatMap((group) => group.aliases ?? [])
  ].map((alias) => alias.toLowerCase());
  assert.equal(new Set(aliases).size, aliases.length, "duplicate alias");
  for (const alias of aliases) {
    assert.ok(!names.has(alias), `alias "${alias}" is also a name`);
  }
  assert.ok(!aliases.includes("provider"));
  assert.ok(!aliases.includes("lead team"));
  assert.ok(!aliases.includes("mfa"));
});

test("handoffs and outside contacts point at real teams and functions", () => {
  const teamNames = new Set(TEAMS.map((team) => team.name));
  for (const handoff of HANDOFFS) {
    assert.ok(teamNames.has(handoff.from), handoff.from);
    assert.ok(teamNames.has(handoff.to), handoff.to);
    assert.notEqual(handoff.from, handoff.to);
  }
  for (const group of OUTSIDE_OPERATIONS) {
    const team = TEAMS.find((t) => t.name === group.contact.team);
    assert.ok(team, group.contact.team);
    assert.ok(
      team.functions.some((fn) => fn.name === group.contact.fn),
      `${group.name}: ${group.contact.fn}`
    );
  }
});

test("carries no people, channels, links, arrows, dashes, or vendor products", () => {
  for (const s of dataStrings()) {
    assert.doesNotMatch(s, /#\S/, s);
    assert.doesNotMatch(s, /@|https?:\/\/|slack|unverified|interim/i, s);
    assert.doesNotMatch(s, /[—→\u{1F300}-\u{1FAFF}]/u, s);
    assert.doesNotMatch(s, /\bRegal\b|\bAWS\b/, s);
    assert.doesNotMatch(
      s,
      /Stephanie|Dangberg|Mallory|Elson|Erik|Muci|Lindsay/,
      s
    );
  }
});

test("leaves the overview page's open questions and design notes out", () => {
  for (const s of dataStrings()) {
    assert.doesNotMatch(
      s,
      /activation gate|staffing track|clinical quality|design note|senior director|triage lead/i,
      s
    );
  }
});

test("describes what a function covers, never how", () => {
  const covers = [
    ...TEAMS.flatMap((team) => team.functions.map((fn) => fn.covers)),
    ...OUTSIDE_OPERATIONS.map((group) => group.covers)
  ];
  for (const text of covers) {
    assert.doesNotMatch(
      text,
      /^(Open|Click|Select|Create|Call|Send|Check|Log|Go to)\b/,
      text
    );
    assert.ok(text.length <= 220, `too long: ${text}`);
  }
});

test("is deterministic, omits empty blocks, and has no trailing newline", () => {
  assert.equal(renderTeamStructure(), rendered);
  assert.equal(rendered, rendered.trimEnd());
  const teamsOnly = renderTeamStructure(TEAMS, [], []);
  assert.doesNotMatch(teamsOnly, /Handoffs|Outside Operations/);
  assert.match(rendered, /\nHandoffs \(/);
  assert.match(rendered, /\nOutside Operations \(/);
});

test("fits the team structure budget", () => {
  assert.ok(rendered.length > 2_000, String(rendered.length));
  assert.ok(
    rendered.length <= TEAM_STRUCTURE_MAX_CHARS,
    `${rendered.length} > ${TEAM_STRUCTURE_MAX_CHARS}`
  );
});
