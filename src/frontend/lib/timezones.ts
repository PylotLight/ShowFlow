/**
 * Default broadcast/bases timezone preferences mirror the most common *arr +
 * anime setups and intentionally lean on IANA's canonical zone names so
 * `Intl.DateTimeFormat` accepts them unmodified.
 */
export const TIMEZONE_PRESETS = [
  { value: "America/New_York", label: "US Eastern (default)" },
  { value: "America/Chicago", label: "US Central" },
  { value: "America/Denver", label: "US Mountain" },
  { value: "America/Los_Angeles", label: "US Pacific" },
  { value: "Australia/Sydney", label: "Australia — Sydney" },
  { value: "Australia/Melbourne", label: "Australia — Melbourne" },
  { value: "Australia/Brisbane", label: "Australia — Brisbane" },
  { value: "Australia/Perth", label: "Australia — Perth" },
  { value: "Australia/Adelaide", label: "Australia — Adelaide" },
  { value: "Australia/Darwin", label: "Australia — Darwin" },
  { value: "Pacific/Auckland", label: "New Zealand" },
  { value: "Asia/Tokyo", label: "Japan (Tokyo)" },
  { value: "Asia/Shanghai", label: "China (Shanghai)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Seoul", label: "Korea (Seoul)" },
  { value: "Europe/London", label: "UK (London)" },
  { value: "Europe/Paris", label: "France (Paris)" },
  { value: "Europe/Berlin", label: "Germany (Berlin)" },
  { value: "Europe/Amsterdam", label: "Netherlands" },
  { value: "UTC", label: "UTC" },
] as const;

export const TIMEZONE_DEFAULT = "America/New_York";
