import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateEmbeddings } from "./embeddings";

function fakeVoyageResponse(embeddings: number[][]) {
  return {
    ok: true,
    json: async () => ({
      data: embeddings.map((embedding, index) => ({ embedding, index })),
    }),
  };
}

describe("generateEmbeddings", () => {
  beforeEach(() => {
    process.env.VOYAGE_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it("returns an empty array without making a request for no texts", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await generateEmbeddings([])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("calls Voyage's embeddings endpoint and returns the vectors in order", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        fakeVoyageResponse([
          [0.1, 0.2],
          [0.3, 0.4],
        ]),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(["hello", "world"]);

    expect(result).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(options.headers.Authorization).toBe("Bearer test-key");
    expect(JSON.parse(options.body).input).toEqual(["hello", "world"]);
  });

  it("re-sorts results by index in case the API returns them out of order", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [9, 9], index: 1 },
          { embedding: [1, 1], index: 0 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(["a", "b"]);

    expect(result).toEqual([
      [1, 1],
      [9, 9],
    ]);
  });

  it("splits more than 128 texts into multiple batch requests", async () => {
    const texts = Array.from({ length: 150 }, (_, i) => `text-${i}`);
    const fetchMock = vi.fn().mockImplementation(async (_url, options) => {
      const body = JSON.parse(options.body);
      return fakeVoyageResponse(body.input.map(() => [1]));
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateEmbeddings(texts);

    expect(result).toHaveLength(150);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a clear error when the API key is missing", async () => {
    delete process.env.VOYAGE_API_KEY;
    vi.stubGlobal("fetch", vi.fn());

    await expect(generateEmbeddings(["hi"])).rejects.toThrow(
      /VOYAGE_API_KEY/,
    );
  });

  it("throws with the response body when the request fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => "invalid api key",
      }),
    );

    await expect(generateEmbeddings(["hi"])).rejects.toThrow(
      /401.*invalid api key/,
    );
  });
});
