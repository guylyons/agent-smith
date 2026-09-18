// tests/preload.ts — loaded before every test file (see bunfig.toml).
import { afterAll } from "bun:test";
import { cleanupFixtures } from "./fixtures";

afterAll(cleanupFixtures);
