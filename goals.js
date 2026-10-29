// The two daily goals, kept in the account's settings record (users/<id>/meta/settings). The
// Habits page lets the person change them; the Tracker graph draws them. Both read them through
// here, so the defaults and the limits can never disagree between the two pages.

export const GOAL_DEFAULTS = { proteinTarget: 140, calorieLimit: 2000 };
export const GOAL_MAX = { proteinTarget: 1000, calorieLimit: 20000 };

export function isValidGoal(setting, value) {
  return Number.isInteger(value) && value >= 1 && value <= GOAL_MAX[setting];
}

// Turns a settings record into { proteinTarget, calorieLimit }. A missing or invalid value means the default.
export function readGoals(data) {
  const goals = { ...GOAL_DEFAULTS };
  for (const setting of Object.keys(GOAL_DEFAULTS)) {
    if (isValidGoal(setting, data[setting])) {
      goals[setting] = data[setting];
    }
  }
  return goals;
}
