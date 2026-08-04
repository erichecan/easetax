import { test } from "node:test";
import assert from "node:assert/strict";
import { DOC_STATUSES, type DocStatus } from "./doc-status";
import { isDone, isException, stageOf, summarizePipeline, STAGES, STAGE_META } from "./pipeline";

test("每个 DocStatus 都有归属：主链某一段 / 异常 / 已完成，无遗漏", () => {
  for (const st of DOC_STATUSES) {
    const covered = stageOf(st) !== null || isException(st) || isDone(st);
    assert.ok(covered, `${st} 没有归属，界面上会消失`);
  }
});

test("归属互斥：不会同时算进两处", () => {
  for (const st of DOC_STATUSES) {
    const n = [stageOf(st) !== null, isException(st), isDone(st)].filter(Boolean).length;
    assert.equal(n, 1, `${st} 归属重复`);
  }
});

test("五段顺序与序号一致", () => {
  assert.deepEqual(
    STAGES.map((s) => STAGE_META[s].index),
    [1, 2, 3, 4, 5],
  );
});

test("统计各段积压、异常与已完成", () => {
  const input: DocStatus[] = [
    "received",
    "received",
    "ocr_processing",
    "needs_review",
    "needs_review",
    "needs_review",
    "confirmed",
    "synced",
    "synced",
    "ocr_failed",
    "duplicate_suspected",
  ];
  const s = summarizePipeline(input);
  assert.equal(s.counts.intake, 2);
  assert.equal(s.counts.extract, 1);
  assert.equal(s.counts.classify, 0);
  assert.equal(s.counts.review, 3);
  assert.equal(s.counts.post, 1);
  assert.equal(s.done, 2);
  assert.equal(s.exceptions, 2);
});

test("堵点只标人工段：机器段积压再多也不算堵", () => {
  const s = summarizePipeline(["received", "received", "received", "received", "needs_review"]);
  assert.equal(s.bottleneck, "review");
});

test("人工段都空时没有堵点", () => {
  assert.equal(summarizePipeline(["received", "synced"]).bottleneck, null);
});

test("两个人工段都有积压时取多的那个", () => {
  const s = summarizePipeline(["needs_review", "confirmed", "confirmed", "confirmed"]);
  assert.equal(s.bottleneck, "post");
});
