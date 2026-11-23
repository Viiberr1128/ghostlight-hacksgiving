const user = { login: 'mara-chen' };
const collaborator = { login: 'devon-reed' };
const issues = [
  { number: 12, title: 'Battery life on the bedside clock', body: 'Would a low-power mode help between tide updates? The backlight is drawing power all night.', user: collaborator, state: 'closed', created_at: '2026-10-04T15:00:00Z', closed_at: '2026-10-19T15:00:00Z' },
  { number: 18, title: 'Make first-run setup clearer', body: 'The welcome screen assumes the tide station has already been selected.', user: collaborator, state: 'open', created_at: '2026-09-22T15:00:00Z' },
  { number: 8, title: 'Calibrate the tide clock during setup', body: 'The displayed tide is offset on older units.', user: collaborator, state: 'open', created_at: '2026-09-09T15:00:00Z' },
];
const comments = [
  { id: 106, issue_url: 'https://api.github.com/repos/harbor-workshop/tide-clock/issues/12', body: 'I’ll add a low-power mode in a follow-up.', user, created_at: '2026-10-05T14:00:00Z' },
  { id: 91, issue_url: 'https://api.github.com/repos/harbor-workshop/tide-clock/issues/18', body: 'I’ll tidy up the onboarding copy this week.', user, created_at: '2026-09-23T14:00:00Z' },
  { id: 58, issue_url: 'https://api.github.com/repos/harbor-workshop/tide-clock/issues/8', body: 'I’ll add a calibration option before the 1.0 release.', user, created_at: '2026-09-10T14:00:00Z' },
];
const pulls = [
  { number: 31, title: 'Add low-power mode', body: 'Adds a low-power mode with a 1 Hz update interval and reduced background work. Closes #12.', user: collaborator, head: { ref: 'low-power' }, state: 'closed', merged_at: '2026-10-18T15:00:00Z', created_at: '2026-10-17T15:00:00Z' },
  { number: 23, title: 'Rework onboarding copy', body: 'First pass at the onboarding copy. Still needs a check on older units. Refs #18.', user: collaborator, head: { ref: 'welcome' }, state: 'open', draft: true, merged_at: null, updated_at: '2026-10-16T15:00:00Z', created_at: '2026-10-15T15:00:00Z' },
];

export function sampleGitHub(stage) {
  const currentPulls = stage === 'before' ? pulls.slice(1) : pulls;
  const currentIssues = stage === 'before' ? [{ ...issues[0], state: 'open', closed_at: null }, ...issues.slice(1)] : issues;
  return {
    snapshot: async () => ({ issues: currentIssues, comments, pulls: currentPulls }),
    issue: async (_, number) => currentIssues.find(item => item.number === number),
    pull: async (_, number) => currentPulls.find(item => item.number === number),
  };
}
