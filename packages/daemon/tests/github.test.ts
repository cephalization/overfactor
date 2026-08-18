import { describe, expect, it } from "vitest";
import { parseGithubRemote, parsePullUrl } from "../src/github.ts";

describe("parseGithubRemote", () => {
  it("parses ssh and https remotes with and without .git", () => {
    expect(parseGithubRemote("git@github.com:cephalization/overfactor.git")).toEqual({
      owner: "cephalization",
      repo: "overfactor",
    });
    expect(parseGithubRemote("https://github.com/Arize-ai/phoenix")).toEqual({
      owner: "Arize-ai",
      repo: "phoenix",
    });
    expect(parseGithubRemote("https://github.com/o/r.git\n")).toEqual({ owner: "o", repo: "r" });
  });

  it("rejects non-github remotes", () => {
    expect(parseGithubRemote("git@gitlab.com:o/r.git")).toBeNull();
    expect(parseGithubRemote("/local/bare/repo.git")).toBeNull();
  });
});

describe("parsePullUrl", () => {
  it("parses pull request URLs, tolerating subpages and queries", () => {
    expect(parsePullUrl("https://github.com/o/r/pull/7")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
    expect(parsePullUrl("https://github.com/o/r/pull/7/files?w=1")).toEqual({
      owner: "o",
      repo: "r",
      number: 7,
    });
  });

  it("rejects issues, repos, and junk", () => {
    expect(parsePullUrl("https://github.com/o/r/issues/7")).toBeNull();
    expect(parsePullUrl("https://github.com/o/r")).toBeNull();
    expect(parsePullUrl("not a url")).toBeNull();
  });
});
