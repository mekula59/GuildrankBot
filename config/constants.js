module.exports = {
  BRAND_COLOR:  0x00ff88,
  GOLD_COLOR:   0xfbbf24,
  RED_COLOR:    0xff3d5a,
  MIN_VC_MINUTES: 5,
  MAX_CREDITED_VC_MINUTES_PER_SESSION: 240,
  ACTIVE_STREAK_MAX_DAY_DIFF: 2,
  DAILY_RECALC_CRON:  '0 2 * * *',   // Daily 2AM UTC
  PENDING_REPAIR_CRON: '*/10 * * * *',
  VC_RECOVERY_LOCK_SECONDS: 300,
  VC_RECOVERY_WARMUP_SECONDS: 20,
  SCHEDULE_MATCH_BEFORE_START_MINUTES: 45,
  SCHEDULE_MATCH_AFTER_START_MINUTES: 90,
  STATS_RECALC_LOCK_SECONDS: 900,
  PENDING_REPAIRS_LOCK_SECONDS: 300,

  BADGES: [
    { id: 'newcomer',    label: '🌱 Newcomer',      minEvents: 1   },
    { id: 'regular',     label: '🎮 Regular',        minEvents: 5   },
    { id: 'veteran',     label: '⚔️ Veteran',        minEvents: 20  },
    { id: 'legend',      label: '🏛️ Legend',         minEvents: 50  },
    { id: 'immortal',    label: '💀 Immortal',       minEvents: 100 },
    { id: 'vc_dweller',  label: '🎧 VC Dweller',    minVcHours: 10 },
    { id: 'vc_marathon', label: '⏱️ VC Marathon',   minVcHours: 50 },
    { id: 'on_fire',     label: '🔥 On Fire',        minStreak: 5   },
    { id: 'unstoppable', label: '⚡ Unstoppable',    minStreak: 10  },
    { id: 'iron_will',   label: '🛡️ Iron Will',      minStreak: 20  },
  ],
};
