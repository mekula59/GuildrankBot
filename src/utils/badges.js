const { BADGES } = require('../../config/constants');

function calculateBadges(stats) {
  const vcHours = Math.floor((stats.total_vc_minutes || 0) / 60);
  return BADGES
    .filter(b => {
      if (b.minEvents  && stats.total_events  < b.minEvents)  return false;
      if (b.minVcHours && vcHours             < b.minVcHours) return false;
      if (b.minStreak  && stats.longest_streak < b.minStreak) return false;
      return true;
    })
    .map(b => b.id);
}

function formatBadges(ids = []) {
  if (!ids.length) return '—';
  return ids.map(id => BADGES.find(b => b.id === id)?.label || id).join('  ');
}

function getNewBadges(oldIds = [], newIds = []) {
  return newIds.filter(b => !oldIds.includes(b));
}

module.exports = { calculateBadges, formatBadges, getNewBadges };
