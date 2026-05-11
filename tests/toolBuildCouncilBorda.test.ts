import test from "node:test";
import assert from "node:assert/strict";
import {
  bordaScores,
  pickCouncilWinner,
  type CouncilBallot,
  type CouncilProposal,
} from "../src/agents/toolBuildCouncil.js";

const proposal = (modelId: string, extras: Partial<CouncilProposal> = {}): CouncilProposal => ({
  modelId,
  content: `proposal by ${modelId}`,
  ...extras,
});

test("bordaScores assigns N-1 points to top, 0 to last", () => {
  // 3 proposals, 1 ballot ranks 0 > 1 > 2 → scores [2, 1, 0]
  const scores = bordaScores([{ voterModelId: "m1", ranking: [0, 1, 2] }], 3);
  assert.deepEqual(scores, [2, 1, 0]);
});

test("bordaScores sums across ballots", () => {
  const ballots: CouncilBallot[] = [
    { voterModelId: "m1", ranking: [0, 1, 2] }, // [2,1,0]
    { voterModelId: "m2", ranking: [1, 0, 2] }, // [1,2,0]
    { voterModelId: "m3", ranking: [2, 0, 1] }, // [1,0,2]
  ];
  assert.deepEqual(bordaScores(ballots, 3), [4, 3, 2]);
});

test("bordaScores ignores out-of-range and duplicate ranks", () => {
  const scores = bordaScores(
    [{ voterModelId: "m1", ranking: [0, 0, 5, 1] }], // dup 0 and out-of-range 5
    3,
  );
  // 0 gets 2 pts (top), 0 dup ignored, 5 ignored, 1 gets 0 pts because position=3
  // Wait — ranking length = 4 but proposalCount = 3; position 3 → points = N-1-3 = -1 → skipped
  assert.deepEqual(scores, [2, 0, 0]);
});

test("pickCouncilWinner picks single highest scorer", () => {
  const proposals = [proposal("alpha"), proposal("beta"), proposal("gamma")];
  const ballots: CouncilBallot[] = [
    { voterModelId: "v1", ranking: [1, 0, 2] }, // beta best
    { voterModelId: "v2", ranking: [1, 2, 0] }, // beta best
  ];
  const winner = pickCouncilWinner(proposals, ballots);
  assert.equal(winner.winnerIndex, 1);
  assert.equal(winner.winnerModelId, "beta");
  assert.equal(winner.tieBrokenBy, "scoresUnique");
});

test("pickCouncilWinner tie-breaks on fewer external deps", () => {
  const proposals = [
    proposal("alpha", { externalDependencies: ["api-x", "api-y"] }),
    proposal("beta", { externalDependencies: [] }),
  ];
  // Tie 1-1
  const ballots: CouncilBallot[] = [
    { voterModelId: "v1", ranking: [0, 1] },
    { voterModelId: "v2", ranking: [1, 0] },
  ];
  const winner = pickCouncilWinner(proposals, ballots);
  assert.equal(winner.winnerModelId, "beta");
  assert.equal(winner.tieBrokenBy, "fewerExternalDeps");
});

test("pickCouncilWinner tie-breaks on shorter package list when ext deps tie", () => {
  const proposals = [
    proposal("alpha", { externalDependencies: [], packageList: ["a", "b", "c"] }),
    proposal("beta", { externalDependencies: [], packageList: ["d"] }),
  ];
  const ballots: CouncilBallot[] = [
    { voterModelId: "v1", ranking: [0, 1] },
    { voterModelId: "v2", ranking: [1, 0] },
  ];
  const winner = pickCouncilWinner(proposals, ballots);
  assert.equal(winner.winnerModelId, "beta");
  assert.equal(winner.tieBrokenBy, "shorterPackageList");
});

test("pickCouncilWinner falls back to lexicographic modelId on full tie", () => {
  const proposals = [proposal("zebra"), proposal("alpha")]; // same deps/pkgs
  const ballots: CouncilBallot[] = [
    { voterModelId: "v1", ranking: [0, 1] },
    { voterModelId: "v2", ranking: [1, 0] },
  ];
  const winner = pickCouncilWinner(proposals, ballots);
  assert.equal(winner.winnerModelId, "alpha");
  assert.equal(winner.tieBrokenBy, "lexicographic");
});

test("pickCouncilWinner throws when proposals are empty", () => {
  assert.throws(() => pickCouncilWinner([], []));
});
