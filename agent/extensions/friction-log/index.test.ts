import assert from "node:assert/strict";
import test from "node:test";
import { buildFrictionContext, CAPTURE_GUIDANCE } from "./index.ts";

test("friction context always includes capture guidance", () => {
    const context = buildFrictionContext([]);
    assert.equal(context, CAPTURE_GUIDANCE);
    assert.match(context, /non-trivial investigation/);
    assert.match(context, /verified workaround/);
    assert.match(context, /ordinary implementation details/);
});

test("friction context appends known records within its bound", () => {
    const context = buildFrictionContext(["Known project friction", "Known harness friction"], 600);
    assert.match(context, /Known project friction/);
    assert.match(context, /Known harness friction/);
    assert.ok(context.length <= 600);

    const clipped = buildFrictionContext(["x".repeat(500)], 450);
    assert.equal(clipped.length, 450);
    assert.match(clipped, /…$/);
});
