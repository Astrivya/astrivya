import { describe, expect, it } from "vitest";
import { pca2 } from "../commands/atlas";

describe("pca2", () => {
  it("projects more rows than the vector dimension (seed must be dim-length)", () => {
    // Regression: seeds were built from row count, so pc[i] was undefined
    // past the row count and every projection came out NaN.
    const vectors = [
      [0.1, -0.2, 0.3, -0.4],
      [0.2, 0.1, -0.3, 0.2],
      [-0.15, 0.25, 0.05, -0.1],
      [0.05, -0.1, -0.2, 0.3],
      [0.3, 0.0, 0.1, -0.25],
    ];
    const projected = pca2(vectors);
    expect(projected).toHaveLength(5);
    for (const [x, y] of projected) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it("keeps distinct points apart (not all collapsed to one spot)", () => {
    const vectors = [
      [0.9, 0.8, 0.7, 0.6],
      [-0.9, -0.8, -0.7, -0.6],
      [0.1, 0.2, 0.3, 0.4],
    ];
    const projected = pca2(vectors);
    const a = projected[0];
    const b = projected[1];
    const dx = a[0] - b[0];
    const dy = a[1] - b[1];
    expect(Math.hypot(dx, dy)).toBeGreaterThan(1e-6);
  });

  it("degrades to zeros for a single point (zero variance)", () => {
    const projected = pca2([[0.5, 0.5, 0.5, 0.5]]);
    expect(projected[0][0]).toBe(0);
    expect(projected[0][1]).toBe(0);
  });
});
