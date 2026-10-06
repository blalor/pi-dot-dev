import assert from "node:assert/strict";
import test from "node:test";
import { completionNotificationsEnabled } from "./macos-notify.ts";

test("completion notifications are disabled inside Herdr", () => {
	assert.equal(completionNotificationsEnabled({ HERDR_ENV: "1" }), false);
});

test("completion notifications remain enabled outside Herdr", () => {
	assert.equal(completionNotificationsEnabled({}), true);
	assert.equal(completionNotificationsEnabled({ HERDR_ENV: "0" }), true);
});
