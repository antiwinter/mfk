export function computeNextBoundary(policy, now = new Date()) {
  if (policy === 'next_try') {
    return now.toISOString();
  }

  if (policy === 'hourly') {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }

  if (policy === 'daily') {
    const next = new Date(now);
    next.setUTCDate(next.getUTCDate() + 1);
    next.setUTCHours(0, 0, 0, 0);
    return next.toISOString();
  }

  if (policy === 'monthly') {
    const next = new Date(now);
    next.setUTCMonth(next.getUTCMonth() + 1, 1);
    next.setUTCHours(0, 0, 0, 0);
    return next.toISOString();
  }

  throw new Error(`Unknown reset policy: ${policy}`);
}

export function isCooldownActive(disabledUntil, now = new Date()) {
  if (!disabledUntil) {
    return false;
  }

  return new Date(disabledUntil).getTime() > now.getTime();
}