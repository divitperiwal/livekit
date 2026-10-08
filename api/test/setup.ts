import { setDefaultTimeout } from "bun:test";

// Each test builds a fresh in-process Postgres and applies every migration (about 2 s).
setDefaultTimeout(30_000);
