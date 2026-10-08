const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Our ids are UUIDs; anything else cannot name a row, so lookups treat it as not found. */
export const isUuid = (value: string | null | undefined): value is string =>
  !!value && UUID.test(value);
