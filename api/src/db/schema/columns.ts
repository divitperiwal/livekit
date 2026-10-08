import { numeric, timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().defaultRandom();

export const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const at = (name: string) => timestamp(name, { withTimezone: true });

/** Rupees and paise, stored exact and read back as a string. Priced amounts are rounded once, when written. */
export const inr = (name: string) => numeric(name, { precision: 14, scale: 2 });

/** Cost components are fractions of a paisa per call; kept at four places. */
export const costInr = (name: string) => numeric(name, { precision: 14, scale: 4 });
