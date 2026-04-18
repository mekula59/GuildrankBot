const {
  MIN_VC_MINUTES,
  MAX_CREDITED_VC_MINUTES_PER_SESSION,
} = require('../../config/constants');

function buildVcCreditDecision(durationMinutes, hadCompanion) {
  const rawDurationMinutes = Math.max(0, durationMinutes || 0);

  if (!hadCompanion) {
    return {
      rawDurationMinutes,
      creditedMinutes: 0,
      antiFarmingReason: 'no_companion',
    };
  }

  if (rawDurationMinutes < MIN_VC_MINUTES) {
    return {
      rawDurationMinutes,
      creditedMinutes: 0,
      antiFarmingReason: 'below_minimum',
    };
  }

  if (rawDurationMinutes > MAX_CREDITED_VC_MINUTES_PER_SESSION) {
    return {
      rawDurationMinutes,
      creditedMinutes: MAX_CREDITED_VC_MINUTES_PER_SESSION,
      antiFarmingReason: 'session_cap',
    };
  }

  return {
    rawDurationMinutes,
    creditedMinutes: rawDurationMinutes,
    antiFarmingReason: null,
  };
}

module.exports = { buildVcCreditDecision };
